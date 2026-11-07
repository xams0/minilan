// Fenêtre de RegieIA.exe : état de la régie, accès aux pages, journal, version.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace AgentRegie
{
    public class RegieForm : Form
    {
        static readonly Color Panel_ = ColorTranslator.FromHtml("#0b111e");
        static readonly Color Raised = ColorTranslator.FromHtml("#0f1729");
        static readonly Color Line_ = ColorTranslator.FromHtml("#2c3c60");
        static readonly Color Ink = ColorTranslator.FromHtml("#e8ecf5");
        static readonly Color Dim = ColorTranslator.FromHtml("#8c98b8");
        static readonly Color Cyan = ColorTranslator.FromHtml("#35e6ff");
        static readonly Color Violet = ColorTranslator.FromHtml("#8b6bff");
        static readonly Color Win = ColorTranslator.FromHtml("#35e6a0");
        static readonly Color Warn = ColorTranslator.FromHtml("#ffb648");
        static readonly Color Danger = ColorTranslator.FromHtml("#ff4470");

        const int MaxLogChars = 60000;
        const int UpdateCheckMs = 5000; // sans réponse dans ce délai, la régie démarre quand même

        readonly string[] args;
        readonly bool updated;
        readonly string feed;
        readonly RegieApp app = new RegieApp();

        readonly Label dotState = new Label(), lblState = new Label(), lblDeck = new Label(), lblVersion = new Label();
        readonly Button btnStart = new Button(), btnPanel = new Button(), btnSettings = new Button(), btnObs = new Button(), btnUpdate = new Button();
        readonly TextBox txtLog = new TextBox();
        readonly ToolTip tips = new ToolTip();
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer { Interval = 1000 };

        int port;
        int ticks;
        bool startDecided;
        bool updating;
        bool closingForUpdate;
        UpdateInfo available;

        public RegieForm(string[] args, bool updated, string feed)
        {
            this.args = args;
            this.updated = updated;
            this.feed = feed;
            BuildUi();
            app.Line += text => OnUi(() => AddLog(text));
            app.RunningChanged += running => OnUi(() => ShowRunning(running));
            Shown += (s, e) => OnFirstShown();
            timer.Tick += (s, e) => { if (++ticks % 3600 == 0) CheckForUpdate(false); };
            timer.Start();
        }

        /// <summary>Une relance après mise à jour ne prend pas le clavier</summary>
        protected override bool ShowWithoutActivation { get { return updated; } }

        void OnUi(Action action)
        {
            if (IsDisposed || !IsHandleCreated) return;
            try { BeginInvoke(action); }
            catch (InvalidOperationException) { /* fenêtre en cours de fermeture */ }
        }

        // ---- Interface ----

        void Style(Button b, string text)
        {
            b.Text = text;
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderColor = Line_;
            b.BackColor = Raised;
            b.ForeColor = Ink;
            b.UseVisualStyleBackColor = false;
            b.Size = new Size(128, 34);
            b.Margin = new Padding(0, 0, 8, 8);
        }

        void BuildUi()
        {
            SuspendLayout();
            AutoScaleDimensions = new SizeF(96F, 96F);
            AutoScaleMode = AutoScaleMode.Dpi;
            Text = "Régie IA";
            Font = new Font("Segoe UI", 9.75F);
            BackColor = Panel_;
            ForeColor = Ink;
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(620, 500);
            DoubleBuffered = true;

            var title = new Label { Text = "RÉGIE IA", AutoSize = true, Font = new Font("Segoe UI Semibold", 12.5F), Location = new Point(26, 20) };

            dotState.Text = "●";
            dotState.AutoSize = true;
            dotState.ForeColor = Dim;
            dotState.Location = new Point(26, 52);
            lblState.AutoSize = false;
            lblState.AutoEllipsis = true;
            lblState.Location = new Point(44, 52);
            lblState.Size = new Size(550, 22);
            lblState.Text = "Préparation…";

            lblDeck.AutoSize = false;
            lblDeck.AutoEllipsis = true;
            lblDeck.ForeColor = Dim;
            lblDeck.Location = new Point(26, 76);
            lblDeck.Size = new Size(568, 22);

            var buttons = new FlowLayoutPanel { Location = new Point(26, 106), Size = new Size(580, 44), WrapContents = false, BackColor = Color.Transparent, Margin = new Padding(0) };
            Style(btnStart, "Démarrer");
            Style(btnPanel, "Panneau");
            Style(btnSettings, "Réglages");
            Style(btnObs, "Préparer OBS");
            buttons.Controls.AddRange(new Control[] { btnStart, btnPanel, btnSettings, btnObs });
            btnStart.Enabled = btnPanel.Enabled = btnSettings.Enabled = false;

            txtLog.Multiline = true;
            txtLog.ReadOnly = true;
            txtLog.ScrollBars = ScrollBars.Vertical;
            txtLog.BackColor = Raised;
            txtLog.ForeColor = Ink;
            txtLog.BorderStyle = BorderStyle.FixedSingle;
            txtLog.Font = new Font("Consolas", 9F);
            txtLog.Location = new Point(26, 154);
            txtLog.Size = new Size(568, 282);
            txtLog.TabStop = false;

            lblVersion.AutoSize = false;
            lblVersion.AutoEllipsis = true;
            lblVersion.TextAlign = ContentAlignment.MiddleLeft;
            lblVersion.ForeColor = Dim;
            lblVersion.Location = new Point(26, 446);
            lblVersion.Size = new Size(430, 34);
            Style(btnUpdate, "Mettre à jour");
            btnUpdate.Location = new Point(466, 446);
            btnUpdate.Margin = new Padding(0);
            btnUpdate.Visible = false;

            Controls.AddRange(new Control[] { title, dotState, lblState, lblDeck, buttons, txtLog, lblVersion, btnUpdate });

            btnStart.Click += (s, e) => { if (app.Running) ConfirmStop(); else app.Start(); };
            btnPanel.Click += (s, e) => Open("/");
            btnSettings.Click += (s, e) => Open("/reglages");
            btnObs.Click += (s, e) =>
            {
                string ip = LanAddress();
                if (port == 0 || ip == null) { AddLog("Préparer OBS : lance d'abord la régie, son adresse réseau est nécessaire."); return; }
                string regie = "http://" + ip + ":" + port;
                if (Ask("Créer ou compléter les scènes de la régie dans les OBS réglés dans config.json, avec l'adresse " + regie + " ?")) app.RunSetupObs(regie);
            };
            btnUpdate.Click += (s, e) =>
            {
                if (available != null && (!app.Running || Ask("La régie va s'arrêter quelques secondes pour se mettre à jour. Continuer ?"))) InstallUpdate(available);
            };
            ResumeLayout(true);
        }

        /// <summary>Encoches du contour : cyan en haut à gauche, violet en bas à droite</summary>
        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            float scale = e.Graphics.DpiX / 96F;
            int length = (int)(16 * scale), inset = (int)(7 * scale), width = Math.Max(2, (int)(2 * scale));
            Rectangle r = ClientRectangle;
            using (var cyan = new Pen(Cyan, width))
            using (var violet = new Pen(Violet, width))
            {
                e.Graphics.DrawLine(cyan, inset, inset, inset + length, inset);
                e.Graphics.DrawLine(cyan, inset, inset, inset, inset + length);
                e.Graphics.DrawLine(violet, r.Right - inset, r.Bottom - inset, r.Right - inset - length, r.Bottom - inset);
                e.Graphics.DrawLine(violet, r.Right - inset, r.Bottom - inset, r.Right - inset, r.Bottom - inset - length);
            }
        }

        bool Ask(string question)
        {
            return MessageBox.Show(this, question, "Régie IA", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) == DialogResult.Yes;
        }

        void Open(string page)
        {
            try { Process.Start("http://127.0.0.1:" + port + page); }
            catch (Exception e) { AddLog("Navigateur introuvable : " + e.Message); }
        }

        void AddLog(string text)
        {
            Match m = Regex.Match(text, @"http://localhost:(\d+)");
            if (m.Success && port == 0)
            {
                port = int.Parse(m.Groups[1].Value);
                ShowRunning(app.Running);
            }
            if (txtLog.TextLength > MaxLogChars) txtLog.Text = txtLog.Text.Substring(txtLog.TextLength - MaxLogChars / 2);
            txtLog.AppendText(text + Environment.NewLine);
        }

        /// <summary>Adresse à taper sur le Steam Deck : la première du réseau local, pas celle d'un VPN</summary>
        static string LanAddress()
        {
            try
            {
                return NetworkInterface.GetAllNetworkInterfaces()
                    .Where(n => n.OperationalStatus == OperationalStatus.Up && n.GetIPProperties().GatewayAddresses.Count > 0)
                    .SelectMany(n => n.GetIPProperties().UnicastAddresses)
                    .Select(a => a.Address)
                    .Where(a => a.AddressFamily == AddressFamily.InterNetwork && Regex.IsMatch(a.ToString(), @"^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)"))
                    .Select(a => a.ToString())
                    .FirstOrDefault();
            }
            catch (Exception) { return null; }
        }

        void ShowRunning(bool running)
        {
            btnStart.Enabled = startDecided;
            btnStart.Text = running ? "Arrêter" : "Démarrer";
            btnPanel.Enabled = btnSettings.Enabled = running && port > 0;
            dotState.ForeColor = running ? Win : Danger;
            lblState.Text = running ? (port > 0 ? "En marche sur le port " + port : "Démarrage…") : "Arrêtée";
            string ip = LanAddress();
            lblDeck.Text = running && port > 0 && ip != null ? "Steam Deck : http://" + ip + ":" + port + "/deck" : "";
        }

        void ConfirmStop()
        {
            if (Ask("Arrêter la régie ? Les changements de plan automatiques cessent.")) { port = 0; app.Stop(); }
        }

        // ---- Démarrage et mise à jour ----

        void OnFirstShown()
        {
            ActiveControl = null; // une espace ou Entrée tapée ailleurs à l'ouverture ne doit rien déclencher
            lblVersion.Text = "Version " + Defaults.Version;
            ThreadPool.QueueUserWorkItem(_ =>
            {
                string error = null;
                try { RegieApp.Extract(); }
                catch (Exception e) { error = e.Message; }
                OnUi(() =>
                {
                    if (error != null)
                    {
                        dotState.ForeColor = Danger;
                        lblState.Text = "Impossible de préparer le programme";
                        AddLog(error);
                        return;
                    }
                    Prepared();
                });
            });
        }

        void Prepared()
        {
            if (!Updater.Enabled) { lblVersion.Text = Defaults.Version + ", build local, sans mise à jour"; StartOnce(); return; }
            if (updated) { lblVersion.Text = Defaults.Version + ", mise à jour installée"; lblVersion.ForeColor = Win; StartOnce(); return; }
            lblVersion.Text = Defaults.Version + ", vérification…";
            CheckForUpdate(true);
            // Sans réponse rapide (pas d'internet à la LAN), on n'attend pas plus pour démarrer
            var wait = new System.Windows.Forms.Timer { Interval = UpdateCheckMs };
            wait.Tick += (s, e) => { wait.Stop(); wait.Dispose(); StartOnce(); };
            wait.Start();
        }

        void StartOnce()
        {
            if (startDecided || updating) return;
            startDecided = true;
            try { app.Start(); }
            catch (Exception e) { AddLog("Lancement impossible : " + e.Message); ShowRunning(false); }
        }

        /// <summary>
        /// Avant le démarrage, la mise à jour s'installe seule. Une fois la régie en marche, elle attend un clic :
        /// elle couperait le pilotage en plein direct.
        /// </summary>
        void CheckForUpdate(bool install)
        {
            if (!Updater.Enabled || updating) return;
            ThreadPool.QueueUserWorkItem(_ =>
            {
                UpdateInfo found = null;
                string error = null;
                try { found = Updater.Check(feed); }
                catch (Exception e) { error = e.Message; }
                OnUi(() =>
                {
                    if (updating) return;
                    if (error != null)
                    {
                        if (available == null) lblVersion.Text = Defaults.Version + ", vérification impossible (internet ?)";
                        tips.SetToolTip(lblVersion, error);
                        if (install) StartOnce();
                        return;
                    }
                    available = found;
                    btnUpdate.Visible = found != null;
                    if (found == null) lblVersion.Text = Defaults.Version + ", à jour";
                    if (found != null && install && !startDecided) { InstallUpdate(found); return; }
                    if (found != null) { lblVersion.Text = Defaults.Version + ", " + found.Version + " disponible"; lblVersion.ForeColor = Warn; }
                    if (install) StartOnce();
                });
            });
        }

        void InstallUpdate(UpdateInfo update)
        {
            if (updating) return;
            updating = true;
            btnUpdate.Enabled = false;
            lblVersion.Text = Defaults.Version + ", téléchargement de la " + update.Version + "…";
            lblVersion.ForeColor = Warn;
            ThreadPool.QueueUserWorkItem(_ =>
            {
                string error = null;
                try { Updater.Download(update); }
                catch (Exception e) { error = e.Message; }
                OnUi(() =>
                {
                    if (error == null)
                    {
                        try
                        {
                            app.Stop();
                            Updater.Install(args);
                            closingForUpdate = true;
                            Close(); // la nouvelle version attend la fermeture, puis relance la régie
                            return;
                        }
                        catch (Exception e) { error = e.Message; }
                    }
                    updating = false;
                    btnUpdate.Enabled = true;
                    btnUpdate.Visible = true;
                    lblVersion.Text = Defaults.Version + ", mise à jour impossible";
                    tips.SetToolTip(lblVersion, error);
                    AddLog("Mise à jour impossible : " + error);
                    if (!app.Running) { if (startDecided) app.Start(); else StartOnce(); }
                });
            });
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (!closingForUpdate && app.Running && e.CloseReason == CloseReason.UserClosing && !Ask("Fermer la régie ? Les changements de plan automatiques cessent."))
            {
                e.Cancel = true;
                return;
            }
            app.Stop();
            base.OnFormClosing(e);
        }
    }
}
