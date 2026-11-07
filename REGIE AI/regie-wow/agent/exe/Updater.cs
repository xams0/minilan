// Mise à jour d'un exe depuis les Releases GitHub du dépôt. Partagé par AgentRegie.exe (tags agent-vX.Y.Z) et RegieIA.exe (tags regie-vX.Y.Z) :
// le préfixe du tag et le nom du fichier viennent de Defaults, généré par chaque build.ps1. Publication : .github/workflows/.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace AgentRegie
{
    public class UpdateInfo
    {
        public Version Version;
        public string Url, Sha256;
        public long Size;
    }

    public static class Updater
    {
        const string DefaultFeed = "https://api.github.com/repos/xams0/minilan/releases?per_page=30";
        const long MaxSize = 512L * 1024 * 1024;
        const int SelfTestMs = 15000;

        static readonly string ExePath = Application.ExecutablePath;
        static readonly string NewPath = Path.Combine(Path.GetDirectoryName(ExePath), Path.GetFileNameWithoutExtension(ExePath) + ".update.exe");
        static readonly string OldPath = ExePath + ".old";

        static Updater()
        {
            // Sans cela, un exe compilé avec csc n'active pas forcément TLS 1.2, exigé par GitHub
            ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072;
        }

        public static Version Current { get { return new Version(Defaults.Version); } }

        /// <summary>Un exe compilé à la main (0.0.0) ne se remplace jamais tout seul</summary>
        public static bool Enabled { get { return Current > new Version(0, 0, 0); } }

        static HttpWebRequest Create(string url, int timeout)
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Timeout = timeout;
            req.ReadWriteTimeout = timeout;
            req.UserAgent = Path.GetFileNameWithoutExtension(Defaults.AssetName) + "/" + Defaults.Version; // GitHub refuse les requêtes sans User-Agent
            req.Accept = "application/vnd.github+json";
            return req;
        }

        /// <summary>La version la plus haute publiée si elle dépasse la nôtre, sinon null. Lève une exception sans internet.</summary>
        public static UpdateInfo Check(string feed)
        {
            string text;
            using (WebResponse res = Create(feed ?? DefaultFeed, 15000).GetResponse())
            using (var reader = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                text = reader.ReadToEnd();

            UpdateInfo best = null;
            var json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
            foreach (Dictionary<string, object> release in json.Deserialize<List<Dictionary<string, object>>>(text))
            {
                string tag = Convert.ToString(release["tag_name"]);
                Version version;
                if (Convert.ToBoolean(release["prerelease"]) || !tag.StartsWith(Defaults.TagPrefix, StringComparison.Ordinal)) continue;
                if (!Version.TryParse(tag.Substring(Defaults.TagPrefix.Length), out version) || version <= Current) continue;
                if (best != null && version <= best.Version) continue;
                foreach (Dictionary<string, object> asset in ((IEnumerable)release["assets"]).Cast<Dictionary<string, object>>())
                {
                    if (Convert.ToString(asset["name"]) != Defaults.AssetName) continue;
                    object digest;
                    asset.TryGetValue("digest", out digest);
                    string sha = Convert.ToString(digest);
                    best = new UpdateInfo
                    {
                        Version = version,
                        Url = Convert.ToString(asset["browser_download_url"]),
                        Size = Convert.ToInt64(asset["size"]),
                        Sha256 = sha.StartsWith("sha256:", StringComparison.Ordinal) ? sha.Substring(7) : null
                    };
                    break;
                }
            }
            return best;
        }

        /// <summary>Télécharge la nouvelle version à côté de l'exe et vérifie qu'elle est intacte et qu'elle démarre</summary>
        public static void Download(UpdateInfo update)
        {
            if (update.Size <= 0 || update.Size > MaxSize) throw new InvalidDataException("taille annoncée anormale");
            using (WebResponse res = Create(update.Url, 60000).GetResponse())
            using (Stream input = res.GetResponseStream())
            using (FileStream output = File.Create(NewPath))
                input.CopyTo(output);

            try
            {
                if (new FileInfo(NewPath).Length != update.Size) throw new InvalidDataException("fichier incomplet");
                if (update.Sha256 != null && !string.Equals(Sha256Of(NewPath), update.Sha256, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("empreinte SHA-256 différente");
                SelfTest(update);
            }
            catch (Exception)
            {
                TryDelete(NewPath);
                throw;
            }
        }

        static string Sha256Of(string path)
        {
            using (SHA256 sha = SHA256.Create())
            using (FileStream fs = File.OpenRead(path))
                return BitConverter.ToString(sha.ComputeHash(fs)).Replace("-", "");
        }

        /// <summary>Refuse un exe qui ne démarre pas, ou dont la version n'est pas celle annoncée : il se remettrait à jour sans fin</summary>
        static void SelfTest(UpdateInfo update)
        {
            var info = new ProcessStartInfo(NewPath, "--self-test " + update.Version) { UseShellExecute = false, CreateNoWindow = true };
            using (Process p = Process.Start(info))
            {
                if (!p.WaitForExit(SelfTestMs))
                {
                    p.Kill();
                    throw new InvalidDataException("la nouvelle version ne répond pas");
                }
                if (p.ExitCode != 0) throw new InvalidDataException("la nouvelle version a échoué à son test de démarrage");
            }
        }

        /// <summary>
        /// Windows interdit d'écraser un exe lancé, mais pas de le renommer. Après cet appel, l'appelant doit se fermer :
        /// la nouvelle version attend qu'il soit parti. En cas d'échec, l'exe d'origine est remis en place.
        /// </summary>
        public static void Install(string[] args)
        {
            TryDelete(OldPath);
            File.Move(ExePath, OldPath);
            try
            {
                File.Move(NewPath, ExePath);
                string restart = string.Join(" ", args.Where(a => a != "--updated").Select(Quote).Concat(new[] { "--updated" }));
                Process.Start(new ProcessStartInfo(ExePath, restart) { UseShellExecute = false });
            }
            catch (Exception)
            {
                TryDelete(ExePath);
                File.Move(OldPath, ExePath);
                throw;
            }
        }

        /// <summary>Retire les restes d'une mise à jour. L'ancien exe peut mettre un instant à libérer son fichier.</summary>
        public static void CleanUp()
        {
            TryDelete(NewPath);
            for (int i = 0; i < 25 && File.Exists(OldPath); i++)
            {
                TryDelete(OldPath);
                if (File.Exists(OldPath)) Thread.Sleep(200);
            }
        }

        static void TryDelete(string path)
        {
            try { File.Delete(path); }
            catch (Exception) { /* encore utilisé : retiré au prochain lancement */ }
        }

        /// <summary>Guillemets selon les règles de Windows : une barre oblique avant un guillemet doit être doublée</summary>
        static string Quote(string arg)
        {
            var s = new StringBuilder("\"");
            int slashes = 0;
            foreach (char c in arg)
            {
                if (c == '\\') { slashes++; continue; }
                s.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
                slashes = 0;
                s.Append(c);
            }
            return s.Append('\\', slashes * 2).Append('"').ToString();
        }
    }
}
