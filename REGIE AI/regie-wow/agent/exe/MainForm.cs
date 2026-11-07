// Fenêtre de l'agent : adresse de la régie, joueur, dossier Logs, état de l'envoi.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Threading;
using System.Windows.Forms;

namespace AgentRegie
{
    /// <summary>Liste déroulante sombre : Windows garde sinon une bordure et une flèche claires</summary>
    public class DarkComboBox : ComboBox
    {
        const int WM_PAINT = 0xF;
        public Color BorderColor = ColorTranslator.FromHtml("#2c3c60");
        public Color ArrowColor = ColorTranslator.FromHtml("#8c98b8");

        public DarkComboBox()
        {
            DropDownStyle = ComboBoxStyle.DropDownList;
            FlatStyle = FlatStyle.Flat;
            DrawMode = DrawMode.OwnerDrawFixed;
            ItemHeight = 20;
        }

        protected override void OnDrawItem(DrawItemEventArgs e)
        {
            bool inList = (e.State & DrawItemState.ComboBoxEdit) == 0;
            bool highlighted = inList && (e.State & DrawItemState.Selected) != 0;
            using (var back = new SolidBrush(highlighted ? BorderColor : BackColor)) e.Graphics.FillRectangle(back, e.Bounds);
            if (e.Index >= 0)
            {
                Color fore = Enabled ? ForeColor : ArrowColor;
                TextRenderer.DrawText(e.Graphics, Items[e.Index].ToString(), Font, e.Bounds, fore, TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
            }
        }

        protected override void WndProc(ref Message m)
        {
            base.WndProc(ref m);
            if (m.Msg != WM_PAINT) return;
            using (Graphics g = Graphics.FromHwnd(Handle))
            using (var border = new Pen(BorderColor))
            using (var back = new SolidBrush(BackColor))
            using (var arrow = new SolidBrush(ArrowColor))
            using (var inner = new Pen(BackColor))
            {
                int w = Width, h = Height, button = SystemInformation.VerticalScrollBarWidth;
                g.FillRectangle(back, w - button - 1, 1, button, h - 2);
                g.DrawRectangle(inner, 1, 1, w - 3, h - 3); // efface le liseré clair de Windows quand la liste est désactivée
                g.DrawRectangle(border, 0, 0, w - 1, h - 1);
                int cx = w - button / 2 - 1, cy = h / 2;
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                g.FillPolygon(arrow, new[] { new Point(cx - 4, cy - 2), new Point(cx + 4, cy - 2), new Point(cx, cy + 3) });
            }
        }
    }

    public class MainForm : Form
    {
        static readonly Color Void = ColorTranslator.FromHtml("#05070d");
        static readonly Color Panel_ = ColorTranslator.FromHtml("#0b111e");
        static readonly Color Raised = ColorTranslator.FromHtml("#0f1729");
        static readonly Color Line = ColorTranslator.FromHtml("#2c3c60");
        static readonly Color Ink = ColorTranslator.FromHtml("#e8ecf5");
        static readonly Color Dim = ColorTranslator.FromHtml("#8c98b8");
        static readonly Color Cyan = ColorTranslator.FromHtml("#35e6ff");
        static readonly Color Violet = ColorTranslator.FromHtml("#8b6bff");
        static readonly Color Win = ColorTranslator.FromHtml("#35e6a0");
        static readonly Color Warn = ColorTranslator.FromHtml("#ffb648");
        static readonly Color Danger = ColorTranslator.FromHtml("#ff4470");

        static readonly Dictionary<string, string> KindLabels = new Dictionary<string, string>
        {
            { "death", "mort" }, { "kill", "kill" }, { "boss_start", "pull de boss" }, { "boss_kill", "boss tombé" },
            { "boss_wipe", "wipe" }, { "dmg_out", "dégâts infligés" }, { "dmg_in", "dégâts subis" }, { "heal", "soin" },
            { "cast", "sort lancé" }, { "interrupt", "interruption" }, { "res", "résurrection" }
        };

        readonly Options options;
        readonly Settings settings;
        readonly TextBox txtServer = new TextBox();
        readonly DarkComboBox cboPlayer = new DarkComboBox();
        readonly TextBox txtLogs = new TextBox();
        readonly Button btnRefresh = new Button();
        readonly Button btnBrowse = new Button();
        readonly Button btnStart = new Button();
        readonly Label lblHint = new Label();
        readonly Label dotRegie = new Label(), dotLog = new Label(), dotEvents = new Label();
        readonly Label lblRegie = new Label(), lblLog = new Label(), lblEvents = new Label();
        readonly Label lblVersion = new Label();
        readonly Button btnUpdate = new Button();
        readonly RichTextBox rtbJournal = new RichTextBox();
        readonly ToolTip tips = new ToolTip();
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer { Interval = 1000 };

        AgentCore agent;
        bool autoStartPending;
        bool loadingPlayers;
        const int QuietLogSeconds = 360;

        Font journalBold;
        DateTime agentStartedAt;
        bool wowRunning;
        bool browsing;
        bool updating;
        UpdateInfo available;
        int ticks;

        public MainForm(Options options, Settings settings)
        {
            this.options = options;
            this.settings = settings;
            BuildUi();
            LoadInitialValues();
            timer.Tick += (s, e) => OnTick();
            timer.Start();
        }

        // ---- Interface ----

        Label RowLabel(string text)
        {
            return new Label { Text = text, ForeColor = Dim, AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(0, 6, 8, 6) };
        }

        void StyleInput(Control c)
        {
            c.BackColor = Raised;
            c.ForeColor = Ink;
            c.Dock = DockStyle.Fill;
            c.Margin = new Padding(0, 5, 8, 5);
        }

        void StyleButton(Button b, string text)
        {
            b.Text = text;
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderColor = Line;
            b.BackColor = Raised;
            b.ForeColor = Ink;
            b.Dock = DockStyle.Fill;
            b.Margin = new Padding(0, 4, 0, 4);
            b.UseVisualStyleBackColor = false;
        }

        void BuildUi()
        {
            SuspendLayout();
            AutoScaleDimensions = new SizeF(96F, 96F);
            AutoScaleMode = AutoScaleMode.Dpi;
            Text = "Agent Régie";
            Font = new Font("Segoe UI", 9.75F);
            BackColor = Panel_;
            ForeColor = Ink;
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            AutoSize = true;
            AutoSizeMode = AutoSizeMode.GrowAndShrink;
            Padding = new Padding(0, 0, 26, 20); // à droite et en bas ; à gauche et en haut, c'est la position du tableau
            DoubleBuffered = true;

            var table = new TableLayoutPanel { ColumnCount = 3, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, BackColor = Color.Transparent, Margin = new Padding(0), Location = new Point(26, 22) };
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 118));
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 300));
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 104));

            var title = new Label { Text = "AGENT RÉGIE", AutoSize = true, Font = new Font("Segoe UI Semibold", 12.5F), ForeColor = Ink, Margin = new Padding(0, 0, 0, 1) };
            var subtitle = new Label { Text = "Envoie les événements de ton combat log à la régie.", AutoSize = true, ForeColor = Dim, Margin = new Padding(0, 0, 0, 12) };
            AddSpanning(table, title);
            AddSpanning(table, subtitle);

            StyleInput(txtServer);
            txtServer.BorderStyle = BorderStyle.FixedSingle;
            StyleButton(btnRefresh, "Actualiser");
            AddRow(table, RowLabel("Régie"), txtServer, btnRefresh);

            StyleInput(cboPlayer);
            AddRow(table, RowLabel("Joueur"), cboPlayer, new Label { AutoSize = false, Width = 1, Height = 1 });

            StyleInput(txtLogs);
            txtLogs.BorderStyle = BorderStyle.FixedSingle;
            txtLogs.ReadOnly = true;
            txtLogs.TabStop = false;
            StyleButton(btnBrowse, "Parcourir…");
            AddRow(table, RowLabel("Dossier Logs"), txtLogs, btnBrowse);

            lblHint.AutoSize = false;
            lblHint.Dock = DockStyle.Fill;
            lblHint.Height = 22;
            lblHint.ForeColor = Warn;
            lblHint.Margin = new Padding(0, 2, 0, 4);
            lblHint.AutoEllipsis = true;
            AddSpanning(table, lblHint);

            StyleButton(btnStart, "Démarrer");
            btnStart.Font = new Font("Segoe UI Semibold", 10.5F);
            btnStart.Height = 38;
            btnStart.Margin = new Padding(0, 0, 0, 12);
            AddSpanning(table, btnStart);

            AddStatus(table, "Régie", dotRegie, lblRegie);
            AddStatus(table, "Combat log", dotLog, lblLog);
            AddStatus(table, "Événements", dotEvents, lblEvents);

            lblVersion.AutoSize = false;
            lblVersion.AutoEllipsis = true;
            lblVersion.Dock = DockStyle.Fill;
            lblVersion.TextAlign = ContentAlignment.MiddleLeft;
            lblVersion.ForeColor = Ink;
            lblVersion.Margin = new Padding(0, 0, 8, 0);
            StyleButton(btnUpdate, "Mettre à jour");
            btnUpdate.Visible = false;
            AddRow(table, RowLabel("Version"), lblVersion, btnUpdate);
            table.RowStyles[table.RowCount - 1] = new RowStyle(SizeType.Absolute, 34); // même hauteur avec ou sans le bouton

            var reminder = new Label
            {
                Text = "En jeu, tape /combatlog une fois par session. Le retaper le coupe.",
                AutoSize = true, ForeColor = Dim, Margin = new Padding(0, 12, 0, 0)
            };
            AddSpanning(table, reminder);

            AddSpanning(table, new Label { Text = "Journal : ce que l'agent reconnaît dans le log", AutoSize = true, ForeColor = Dim, Margin = new Padding(0, 14, 0, 4) });
            rtbJournal.ReadOnly = true;
            rtbJournal.TabStop = false;
            rtbJournal.DetectUrls = false;
            rtbJournal.BackColor = Raised;
            rtbJournal.ForeColor = Ink;
            rtbJournal.BorderStyle = BorderStyle.None;
            rtbJournal.ScrollBars = RichTextBoxScrollBars.Vertical;
            rtbJournal.Height = 210;
            rtbJournal.Margin = new Padding(0);
            AddSpanning(table, rtbJournal);

            Controls.Add(table);

            btnRefresh.Click += (s, e) => RefreshPlayers();
            btnBrowse.Click += (s, e) => BrowseForLogs();
            btnStart.Click += (s, e) => { if (agent == null) StartAgent(); else StopAgent(); };
            btnUpdate.Click += (s, e) => { if (available != null) InstallUpdate(available); };
            txtServer.Leave += (s, e) => { if (RegieApi.Normalize(txtServer.Text) != settings.Server) { settings.Server = RegieApi.Normalize(txtServer.Text); settings.Save(); RefreshPlayers(); } };
            txtServer.KeyDown += (s, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; RefreshPlayers(); } };
            cboPlayer.SelectedIndexChanged += (s, e) => { var p = cboPlayer.SelectedItem as PlayerInfo; if (p != null) { settings.Player = p.Name; settings.Save(); } };
            Shown += (s, e) => OnFirstShown();
            ResumeLayout(true);
        }

        void AddRow(TableLayoutPanel table, Control a, Control b, Control c)
        {
            int row = table.RowCount++;
            table.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            table.Controls.Add(a, 0, row);
            table.Controls.Add(b, 1, row);
            table.Controls.Add(c, 2, row);
        }

        void AddSpanning(TableLayoutPanel table, Control c)
        {
            int row = table.RowCount++;
            table.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            table.Controls.Add(c, 0, row);
            table.SetColumnSpan(c, 3);
            if (!c.AutoSize) c.Dock = DockStyle.Fill;
        }

        void AddStatus(TableLayoutPanel table, string name, Label dot, Label value)
        {
            int row = table.RowCount++;
            table.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            table.Controls.Add(new Label { Text = name, ForeColor = Dim, AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(0, 3, 8, 3) }, 0, row);

            var line = new FlowLayoutPanel { AutoSize = false, Dock = DockStyle.Fill, Height = 24, Margin = new Padding(0), WrapContents = false, BackColor = Color.Transparent };
            dot.Text = "●";
            dot.AutoSize = true;
            dot.ForeColor = Dim;
            dot.Margin = new Padding(0, 3, 4, 0);
            value.AutoSize = false;
            value.Width = 380;
            value.Height = 22;
            value.AutoEllipsis = true;
            value.ForeColor = Ink;
            value.Margin = new Padding(0, 3, 0, 0);
            line.Controls.Add(dot);
            line.Controls.Add(value);
            table.Controls.Add(line, 1, row);
            table.SetColumnSpan(line, 2);
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

        // ---- Valeurs de départ ----

        void LoadInitialValues()
        {
            settings.Server = options.Server ?? settings.Server ?? Defaults.Server;
            txtServer.Text = settings.Server;
            if (options.Server != null || options.Logs != null) settings.Save();

            string logs = options.Logs ?? settings.Logs;
            SetLogs(LogFinder.IsValid(logs) ? logs : null);

            autoStartPending = options.AutoStart || settings.AutoStart;
            ShowStopped();
        }

        void SetLogs(string path)
        {
            txtLogs.Text = path ?? "";
            tips.SetToolTip(txtLogs, path ?? "");
            settings.Logs = path;
            settings.Save();
        }

        /// <summary>Une relance après mise à jour ne prend pas le clavier à celui qui joue ou qui écrit</summary>
        protected override bool ShowWithoutActivation { get { return options != null && options.Updated; } }

        void OnFirstShown()
        {
            // Aucun contrôle sélectionné : une espace ou Entrée tapée ailleurs à l'ouverture ne doit pas couper l'agent
            ActiveControl = null;
            txtServer.SelectionLength = 0;
            txtLogs.SelectionLength = 0;
            RefreshPlayers();
            if (!Updater.Enabled) ShowVersion("build local, sans mise à jour", Dim);
            else if (options.Updated) ShowVersion("mise à jour installée", Win);
            else
            {
                ShowVersion("vérification…", Dim);
                CheckForUpdate(true);
            }
            if (!LogFinder.IsValid(txtLogs.Text))
            {
                lblHint.Text = LogsHelp;
                if (!options.NoPrompt) BrowseForLogs();
            }
        }

        const string LogsHelp = @"Choisis le dossier Logs du jeu : World of Warcraft\_forever_\Logs";

        void BrowseForLogs()
        {
            using (var dialog = new FolderBrowserDialog { Description = LogsHelp, ShowNewFolderButton = false })
            {
                if (LogFinder.IsValid(txtLogs.Text)) dialog.SelectedPath = txtLogs.Text;
                browsing = true;
                DialogResult answer = dialog.ShowDialog(this);
                browsing = false;
                if (answer != DialogResult.OK) return;
                if (LogFinder.IsValid(dialog.SelectedPath))
                {
                    SetLogs(dialog.SelectedPath);
                    lblHint.Text = "";
                    TryAutoStart();
                }
                else lblHint.Text = @"Ce dossier ne s'appelle pas Logs : choisis ...\_forever_\Logs";
            }
        }

        // ---- Mise à jour ----

        void ShowVersion(string note, Color color)
        {
            lblVersion.Text = Defaults.Version + ", " + note;
            lblVersion.ForeColor = color;
        }

        /// <summary>
        /// Au lancement, la mise à jour s'installe seule. En cours de session, elle attend un clic :
        /// la fenêtre qui se rouvre sortirait le joueur de son jeu.
        /// </summary>
        void CheckForUpdate(bool install)
        {
            if (!Updater.Enabled || updating) return;
            ThreadPool.QueueUserWorkItem(_ =>
            {
                UpdateInfo found = null;
                string error = null;
                try { found = Updater.Check(options.UpdateFeed); }
                catch (Exception e) { error = e.Message; }
                if (IsDisposed) return;
                BeginInvoke((Action)(() =>
                {
                    if (updating) return;
                    if (error != null)
                    {
                        if (available == null && !options.Updated) ShowVersion("vérification impossible (internet ?)", Dim);
                        tips.SetToolTip(lblVersion, error);
                        return;
                    }
                    tips.SetToolTip(lblVersion, "");
                    available = found;
                    btnUpdate.Visible = found != null;
                    if (found == null) { if (!options.Updated) ShowVersion("à jour", Dim); }
                    else if (install && !browsing) InstallUpdate(found);
                    else ShowVersion(found.Version + " disponible", Warn);
                }));
            });
        }

        void InstallUpdate(UpdateInfo update)
        {
            if (updating) return;
            updating = true;
            btnUpdate.Enabled = false;
            ShowVersion("installation de la " + update.Version + "…", Warn);
            ThreadPool.QueueUserWorkItem(_ =>
            {
                string error = null;
                try { Updater.Download(update); }
                catch (Exception e) { error = e.Message; }
                if (IsDisposed) return;
                BeginInvoke((Action)(() =>
                {
                    if (error == null)
                    {
                        try
                        {
                            Updater.Install(options.Args);
                            Close(); // la nouvelle version attend la fermeture, puis reprend l'envoi toute seule
                            return;
                        }
                        catch (Exception e) { error = e.Message; }
                    }
                    updating = false;
                    btnUpdate.Enabled = true;
                    btnUpdate.Visible = true;
                    ShowVersion("mise à jour impossible", Warn);
                    tips.SetToolTip(lblVersion, error);
                }));
            });
        }

        // ---- Journal ----

        const int JournalMaxLines = 300;
        const double JournalLateSeconds = 3;

        Color TagColor(string tag)
        {
            switch (tag)
            {
                case "MORT": return Danger;
                case "BOSS": return Violet;
                case "KILL": case "RÉSURRECTION": case "INTERRUPTION": return Win;
                case "PVP": case "BG": case "ARÈNE": return Warn;
                case "ZONE": case "INSTANCE": return Cyan;
                default: return Dim;
            }
        }

        void JournalWrite(string text, Color color, bool bold)
        {
            rtbJournal.SelectionStart = rtbJournal.TextLength;
            rtbJournal.SelectionLength = 0;
            rtbJournal.SelectionColor = color;
            rtbJournal.SelectionFont = bold ? journalBold : rtbJournal.Font;
            rtbJournal.SelectedText = text;
        }

        void AddToJournal(JournalEntry e)
        {
            // Le texte est figé pour le joueur, pas pour le programme : RichTextBox refuse d'écrire en lecture seule
            rtbJournal.ReadOnly = false;
            if (journalBold == null) journalBold = new Font(rtbJournal.Font, FontStyle.Bold);
            rtbJournal.SelectionStart = rtbJournal.TextLength;
            rtbJournal.SelectionTabs = new[] { 62, 172 };
            rtbJournal.SelectionHangingIndent = 172;

            if (rtbJournal.TextLength > 0) JournalWrite("\n", Ink, false);
            JournalWrite((e.LogTime != null ? e.LogTime.Value.ToString("HH:mm:ss") : "") + "\t", Dim, false);
            JournalWrite(e.Tag + "\t", TagColor(e.Tag), true);
            foreach (JournalPart p in e.Parts)
            {
                if (p.Kind == PartKind.Self) JournalWrite(p.Text, Cyan, true);
                else if (p.Kind == PartKind.OtherPlayer) JournalWrite(p.Text, Warn, true);
                else JournalWrite(p.Text, Ink, false);
            }
            if (e.LogTime != null)
            {
                double late = (e.ReadAt - e.LogTime.Value).TotalSeconds;
                if (late >= JournalLateSeconds) JournalWrite("  " + Math.Round(late) + " s de retard", Dim, false);
            }

            if (rtbJournal.Lines.Length > JournalMaxLines)
            {
                rtbJournal.Select(0, rtbJournal.GetFirstCharIndexFromLine(rtbJournal.Lines.Length - JournalMaxLines));
                rtbJournal.SelectedText = "";
            }
            rtbJournal.ReadOnly = true;
        }

        void DrainJournal()
        {
            if (agent == null) return;
            List<JournalEntry> entries = agent.TakeJournal();
            if (entries.Count == 0) return;
            foreach (JournalEntry e in entries) AddToJournal(e);
            // Pas de défilement pendant que le joueur lit ou sélectionne dans le journal
            if (!rtbJournal.Focused)
            {
                rtbJournal.SelectionStart = rtbJournal.TextLength;
                rtbJournal.ScrollToCaret();
            }
        }

        // ---- Joueurs ----

        void RefreshPlayers()
        {
            string server = RegieApi.Normalize(txtServer.Text);
            if (server.Length == 0 || loadingPlayers) return;
            loadingPlayers = true;
            ThreadPool.QueueUserWorkItem(_ =>
            {
                List<PlayerInfo> players = null;
                string error = null;
                try { players = RegieApi.ReadPlayers(server); }
                catch (Exception e) { error = e.Message; }
                if (IsDisposed) return;
                BeginInvoke((Action)(() =>
                {
                    loadingPlayers = false;
                    if (players != null) ShowPlayers(players);
                    else if (agent == null)
                    {
                        lblRegie.Text = "Injoignable : vérifie l'adresse et que la régie est lancée";
                        dotRegie.ForeColor = Danger;
                        tips.SetToolTip(lblRegie, error);
                    }
                }));
            });
        }

        void ShowPlayers(List<PlayerInfo> players)
        {
            if (agent == null) { lblRegie.Text = "Joignable, pas encore démarré"; dotRegie.ForeColor = Dim; tips.SetToolTip(lblRegie, ""); }
            var previous = cboPlayer.SelectedItem as PlayerInfo;
            string wanted = previous != null ? previous.Name : settings.Player;

            cboPlayer.BeginUpdate();
            cboPlayer.Items.Clear();
            foreach (PlayerInfo p in players) cboPlayer.Items.Add(p);
            cboPlayer.EndUpdate();

            PlayerInfo match = null;
            if (options.Player > 0) { match = players.FirstOrDefault(p => p.Index == options.Player - 1); options.Player = 0; }
            if (match == null) match = players.FirstOrDefault(p => string.Equals(p.Name, wanted, StringComparison.OrdinalIgnoreCase));
            if (match != null) cboPlayer.SelectedItem = match;
            TryAutoStart();
        }

        void TryAutoStart()
        {
            if (autoStartPending && agent == null && cboPlayer.SelectedItem != null && LogFinder.IsValid(txtLogs.Text))
            {
                autoStartPending = false;
                StartAgent();
            }
        }

        // ---- Marche / arrêt ----

        void StartAgent()
        {
            string server = RegieApi.Normalize(txtServer.Text);
            var player = cboPlayer.SelectedItem as PlayerInfo;
            if (server.Length == 0) { lblHint.Text = "Indique l'adresse de la régie."; return; }
            if (player == null) { lblHint.Text = "Choisis ton joueur. Si la liste est vide, clique sur Actualiser."; return; }
            if (!LogFinder.IsValid(txtLogs.Text)) { lblHint.Text = LogsHelp; return; }

            lblHint.Text = "";
            settings.Server = server;
            settings.Player = player.Name;
            settings.AutoStart = true;
            settings.Save();

            agentStartedAt = DateTime.Now;
            agent = new AgentCore(server, player.Index, txtLogs.Text);
            agent.Start();
            SetInputsEnabled(false);
            btnStart.Text = "Arrêter";
            OnTick();
        }

        void StopAgent()
        {
            agent.Stop();
            DrainJournal();
            agent = null;
            autoStartPending = false;
            settings.AutoStart = false;
            settings.Save();
            SetInputsEnabled(true);
            btnStart.Text = "Démarrer";
            ShowStopped();
        }

        void SetInputsEnabled(bool enabled)
        {
            txtServer.Enabled = cboPlayer.Enabled = btnRefresh.Enabled = btnBrowse.Enabled = enabled;
        }

        void ShowStopped()
        {
            lblRegie.Text = "Arrêté";
            lblLog.Text = "Arrêté";
            lblEvents.Text = "Aucun envoi";
            dotRegie.ForeColor = dotLog.ForeColor = dotEvents.ForeColor = Dim;
        }

        // ---- État ----

        static string Ago(DateTime? at)
        {
            if (at == null) return "";
            double s = (DateTime.Now - at.Value).TotalSeconds;
            if (s < 60) return "il y a " + Math.Max(0, (int)s) + " s";
            if (s < 3600) return "il y a " + (int)(s / 60) + " min";
            return "il y a " + (int)(s / 3600) + " h";
        }

        void OnTick()
        {
            ticks++;
            if (ticks % 5 == 1) wowRunning = Process.GetProcesses().Any(p => p.ProcessName.StartsWith("wow", StringComparison.OrdinalIgnoreCase));
            if (ticks % 3600 == 0) CheckForUpdate(false);
            DrainJournal();

            if (agent == null)
            {
                if (ticks % 5 == 0 && cboPlayer.Items.Count == 0) RefreshPlayers(); // la régie n'était pas encore lancée
                return;
            }

            AgentStatus s = agent.Snapshot();
            var player = cboPlayer.SelectedItem as PlayerInfo;

            if (s.Connected)
            {
                lblRegie.Text = "Connectée, joueur " + (player != null ? player.Name : "?");
                dotRegie.ForeColor = Win;
                tips.SetToolTip(lblRegie, "");
            }
            else if (s.Error != null)
            {
                lblRegie.Text = "Injoignable, nouvelle tentative…";
                dotRegie.ForeColor = Danger;
                tips.SetToolTip(lblRegie, s.Error);
            }
            else { lblRegie.Text = "Connexion…"; dotRegie.ForeColor = Dim; }

            string fileName = s.LogFile ?? "";
            tips.SetToolTip(lblLog, fileName);
            // WoW garde le log en mémoire et l'écrit à la fin des combats : un long silence est normal hors combat
            DateTime silentSince = s.LastDataAt ?? agentStartedAt;
            bool silentTooLong = (DateTime.Now - silentSince).TotalSeconds >= QuietLogSeconds;
            if (s.LastDataAt != null && !silentTooLong)
            {
                lblLog.Text = "WoW a écrit le log " + Ago(s.LastDataAt);
                dotLog.ForeColor = Win;
            }
            else if (wowRunning && s.LogFile == null)
            {
                lblLog.Text = "Aucun log : tape /combatlog en jeu";
                dotLog.ForeColor = Warn;
            }
            else if (wowRunning && silentTooLong)
            {
                lblLog.Text = "Rien d'écrit " + Ago(silentSince) + " : /combatlog est-il actif ?";
                dotLog.ForeColor = Warn;
            }
            else if (wowRunning)
            {
                lblLog.Text = "En attente : WoW écrit à la fin de chaque combat";
                dotLog.ForeColor = Dim;
            }
            else
            {
                lblLog.Text = "En attente de WoW";
                dotLog.ForeColor = Dim;
            }

            string kind = "";
            if (s.LastKind != null) KindLabels.TryGetValue(s.LastKind, out kind);
            lblEvents.Text = s.Sent + " envoyés" + (s.LastKind != null ? ", dernier : " + kind + " " + Ago(s.LastKindAt) : "");
            dotEvents.ForeColor = s.Sent > 0 ? Win : Dim;
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (agent != null) agent.Stop();
            base.OnFormClosing(e);
        }
    }
}
