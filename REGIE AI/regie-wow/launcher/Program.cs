// Point d'entrée de RegieIA.exe : remplace npm start.
//   RegieIA.exe                    → extrait le programme, se met à jour si besoin, lance la régie
//   Réservés à la mise à jour : --updated  --self-test VERSION  --update-feed URL (autre source, pour les tests)
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace AgentRegie
{
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

        static string ValueAfter(string[] args, string name)
        {
            int i = Array.IndexOf(args, name);
            return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
        }

        [STAThread]
        static int Main(string[] args)
        {
            string selfTest = ValueAfter(args, "--self-test");
            if (selfTest != null) return selfTest == Defaults.Version && RegieApp.HasEmbeddedApp() ? 0 : 3;

            bool updated = Array.IndexOf(args, "--updated") >= 0;
            bool first;
            using (var mutex = new Mutex(true, @"Local\RegieIA", out first))
            {
                if (!first && updated) first = WaitForPrevious(mutex);
                if (!first)
                {
                    MessageBox.Show("La régie est déjà lancée sur ce PC.", "Régie IA", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return 0;
                }
                ThreadPool.QueueUserWorkItem(_ => Updater.CleanUp());
                SetProcessDPIAware();
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new RegieForm(args, updated, ValueAfter(args, "--update-feed")));
            }
            return 0;
        }
    }
}
