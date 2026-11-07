// Fait tourner la régie : extrait le programme intégré à l'exe, lance Node, le relance quand /reglages le demande.
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Windows.Forms;

namespace AgentRegie
{
    public class RegieApp
    {
        public const string Resource = "regie-app.zip";
        const int RestartCode = 75; // compris par src/server.js
        const int StopWaitMs = 6000;

        /// <summary>Dossier de l'exe : config.json et data/ y restent, quelle que soit la version</summary>
        public static readonly string Home = Path.GetDirectoryName(Application.ExecutablePath);

        // Chemin fixe : le pare-feu de Windows retient node.exe par son chemin et ne redemande rien après une mise à jour
        static readonly string AppDir = Path.Combine(Home, "app");

        public event Action<string> Line;
        public event Action<bool> RunningChanged;

        Process server;
        bool stopping;

        public bool Running { get { return server != null; } }

        public static bool HasEmbeddedApp()
        {
            return Assembly.GetExecutingAssembly().GetManifestResourceInfo(Resource) != null;
        }

        /// <summary>Extrait le programme s'il a changé depuis le dernier lancement</summary>
        public static void Extract()
        {
            Assembly assembly = Assembly.GetExecutingAssembly();
            string hash;
            using (Stream s = assembly.GetManifestResourceStream(Resource))
            using (SHA256 sha = SHA256.Create())
                hash = BitConverter.ToString(sha.ComputeHash(s));

            string marker = Path.Combine(AppDir, ".empreinte");
            if (File.Exists(marker) && File.ReadAllText(marker) == hash && File.Exists(Path.Combine(AppDir, "node.exe"))) return;

            string fresh = AppDir + ".new";
            if (Directory.Exists(fresh)) Directory.Delete(fresh, true);
            using (Stream s = assembly.GetManifestResourceStream(Resource))
            using (var zip = new ZipArchive(s, ZipArchiveMode.Read))
                zip.ExtractToDirectory(fresh);
            File.WriteAllText(Path.Combine(fresh, ".empreinte"), hash);

            if (Directory.Exists(AppDir)) Directory.Delete(AppDir, true);
            Directory.Move(fresh, AppDir);
        }

        ProcessStartInfo Node(string script)
        {
            var info = new ProcessStartInfo(Path.Combine(AppDir, "node.exe"), "\"" + script + "\"")
            {
                WorkingDirectory = AppDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };
            info.EnvironmentVariables["REGIE_HOME"] = Home;
            return info;
        }

        void Say(string text) { Action<string> h = Line; if (h != null && text != null) h(text); }

        void Pipe(Process p)
        {
            p.OutputDataReceived += (s, e) => Say(e.Data);
            p.ErrorDataReceived += (s, e) => Say(e.Data);
            p.Start();
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
        }

        public void Start()
        {
            if (server != null) return;
            stopping = false;
            ProcessStartInfo info = Node(@"src\server.js");
            info.EnvironmentVariables["REGIE_SUPERVISED"] = "1";
            info.EnvironmentVariables["REGIE_LAUNCHER"] = "1";
            var p = new Process { StartInfo = info, EnableRaisingEvents = true };
            p.Exited += (s, e) => OnExited(p);
            server = p;
            Pipe(p);
            Action<bool> h = RunningChanged;
            if (h != null) h(true);
        }

        void OnExited(Process p)
        {
            int code = p.ExitCode;
            p.WaitForExit(); // termine la lecture de la sortie
            server = null;
            if (!stopping && code == RestartCode)
            {
                Say("Redémarrage de la régie…");
                Start();
                return;
            }
            if (!stopping && code != 0) Say("La régie s'est arrêtée (code " + code + ").");
            Action<bool> h = RunningChanged;
            if (h != null) h(false);
        }

        /// <summary>Fermer son entrée demande au serveur de sauvegarder et de s'arrêter, voir src/server.js</summary>
        public void Stop()
        {
            Process p = server;
            if (p == null) return;
            stopping = true;
            try
            {
                p.StandardInput.Close();
                if (!p.WaitForExit(StopWaitMs)) p.Kill();
            }
            catch (Exception) { /* déjà arrêté */ }
        }

        /// <summary>Prépare les scènes OBS (scripts/setup-obs.js), la sortie s'affiche dans le journal</summary>
        public void RunSetupObs()
        {
            var p = new Process { StartInfo = Node(@"scripts\setup-obs.js"), EnableRaisingEvents = true };
            p.Exited += (s, e) => Say("Préparation d'OBS terminée (code " + p.ExitCode + ").");
            Pipe(p);
        }
    }
}
