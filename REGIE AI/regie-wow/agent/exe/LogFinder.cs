// Trouve le log en cours dans le dossier Logs choisi par le joueur.
using System;
using System.Globalization;
using System.IO;
using System.Text.RegularExpressions;

namespace AgentRegie
{
    public static class LogFinder
    {
        /// <summary>Le dossier Logs de WoW, par exemple World of Warcraft\_forever_\Logs</summary>
        public static bool IsValid(string path)
        {
            if (string.IsNullOrWhiteSpace(path) || !Directory.Exists(path)) return false;
            return string.Equals(Path.GetFileName(path.TrimEnd('\\', '/')), "Logs", StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>
        /// Date écrite dans le nom : WoWCombatLog-110726_080848.txt = 7 novembre 2026 à 08:08:48, heure locale (MMJJAA_HHMMSS).
        /// Elle est décodée car un tri alphabétique placerait 123126 après 010127.
        /// </summary>
        public static DateTime? DateInName(string fileName)
        {
            Match m = Regex.Match(fileName, @"^WoWCombatLog-(\d{2})(\d{2})(\d{2})_(\d{6})\.txt$", RegexOptions.IgnoreCase);
            if (!m.Success) return null;
            string text = "20" + m.Groups[3].Value + m.Groups[1].Value + m.Groups[2].Value + m.Groups[4].Value;
            DateTime value;
            if (!DateTime.TryParseExact(text, "yyyyMMddHHmmss", CultureInfo.InvariantCulture, DateTimeStyles.AssumeLocal, out value)) return null;
            return value.ToUniversalTime();
        }

        /// <summary>
        /// Le log en cours est celui dont le nom porte la date la plus récente : ré-enregistrer un ancien log
        /// change sa date d'écriture, pas son nom. Un nom sans date se juge sur les dates du fichier.
        /// </summary>
        static DateTime LogTime(FileInfo file)
        {
            DateTime? named = DateInName(file.Name);
            if (named != null) return named.Value;
            // NTFS met parfois à jour la date d'écriture avec retard : la date de création compte aussi
            return file.LastWriteTimeUtc > file.CreationTimeUtc ? file.LastWriteTimeUtc : file.CreationTimeUtc;
        }

        public static FileInfo NewestLog(string logsFolder)
        {
            FileInfo best = null;
            DateTime bestTime = DateTime.MinValue;
            FileInfo[] files;
            try { files = new DirectoryInfo(logsFolder).GetFiles("WoWCombatLog*.txt"); }
            catch (Exception) { return null; }
            foreach (FileInfo file in files)
            {
                DateTime t = LogTime(file);
                if (t > bestTime) { best = file; bestTime = t; }
            }
            return best;
        }
    }
}
