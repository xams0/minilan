// Point d'entrée de l'agent et mémorisation de ses réglages.
//   AgentRegie.exe                 → interface normale
//   --server URL  --player N  --logs DOSSIER  --autostart  --no-prompt  --settings FICHIER
//   Réservés à la mise à jour : --updated  --self-test VERSION  --update-feed URL (autre source, pour les tests)
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace AgentRegie
{
    public class Options
    {
        public string Server, Logs, SettingsFile, SelfTest, UpdateFeed;
        public string[] Args;
        public int Player;
        public bool AutoStart, NoPrompt, Updated;

        public static Options Parse(string[] args)
        {
            var o = new Options { Args = args };
            for (int i = 0; i < args.Length; i++)
            {
                string next = i + 1 < args.Length ? args[i + 1] : null;
                switch (args[i])
                {
                    case "--server": o.Server = RegieApi.Normalize(next); i++; break;
                    case "--logs": o.Logs = next; i++; break;
                    case "--settings": o.SettingsFile = next; i++; break;
                    case "--player": int.TryParse(next, out o.Player); i++; break;
                    case "--autostart": o.AutoStart = true; break;
                    case "--no-prompt": o.NoPrompt = true; break;
                    case "--updated": o.Updated = true; break;
                    case "--self-test": o.SelfTest = next ?? ""; i++; break;
                    case "--update-feed": o.UpdateFeed = next; i++; break;
                }
            }
            return o;
        }
    }

    public class Settings
    {
        public string Server, Player, Logs;
        public bool AutoStart;
        readonly string file;

        public Settings(string file)
        {
            this.file = file ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "AgentRegie", "reglages.ini");
            try
            {
                if (!File.Exists(this.file)) return;
                foreach (string line in File.ReadAllLines(this.file, Encoding.UTF8))
                {
                    int eq = line.IndexOf('=');
                    if (eq < 0) continue;
                    string key = line.Substring(0, eq), value = line.Substring(eq + 1);
                    if (key == "server") Server = value;
                    else if (key == "player") Player = value;
                    else if (key == "logs") Logs = value;
                    else if (key == "autostart") AutoStart = value == "1";
                }
            }
            catch (Exception) { /* réglages illisibles : on repart des valeurs par défaut */ }
        }

        public void Save()
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(file)));
                File.WriteAllLines(file, new[]
                {
                    "server=" + Server, "player=" + Player, "logs=" + Logs, "autostart=" + (AutoStart ? "1" : "0")
                }, Encoding.UTF8);
            }
            catch (Exception) { /* dossier protégé : l'agent marche, il redemandera au prochain lancement */ }
        }
    }

    static class Program
    {
        [DllImport("user32.dll")]
        static extern bool SetProcessDPIAware();

        /// <summary>Après une mise à jour, l'ancienne version est encore en train de se fermer</summary>
        static bool WaitForPrevious(Mutex mutex)
        {
            try { return mutex.WaitOne(15000); }
            catch (AbandonedMutexException) { return true; }
        }

        [STAThread]
        static int Main(string[] args)
        {
            Options options = Options.Parse(args);
            if (options.SelfTest != null) return options.SelfTest == Defaults.Version ? 0 : 3;

            bool first;
            using (var mutex = new Mutex(true, @"Local\AgentRegie", out first))
            {
                if (!first && options.Updated) first = WaitForPrevious(mutex);
                if (!first)
                {
                    MessageBox.Show("L'agent est déjà lancé sur ce PC.", "Agent Régie", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return 0;
                }
                ThreadPool.QueueUserWorkItem(_ => Updater.CleanUp());
                SetProcessDPIAware();
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainForm(options, new Settings(options.SettingsFile)));
            }
            return 0;
        }
    }
}
