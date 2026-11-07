// Transforme une ligne du combat log de WoW en type d'événement pour la régie.
// Même logique que classify() dans agent/agent.mjs : toute évolution doit être faite des deux côtés.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace AgentRegie
{
    public static class CombatLog
    {
        static bool Mine(long f) { return (f & 0xF) == 0x1; }
        static bool IsPlayer(long f) { return (f & 0x400) != 0; }
        static bool IsPet(long f) { return (f & 0x3000) != 0; }
        internal static bool Me(long f) { return Mine(f) && (IsPlayer(f) || IsPet(f)); }
        internal static bool MeExact(long f) { return Mine(f) && IsPlayer(f); }

        /// <summary>Découpe une ligne CSV du combat log (les noms sont entre guillemets)</summary>
        internal static List<string> SplitCsv(string s)
        {
            var result = new List<string>();
            var cur = new StringBuilder();
            bool quoted = false;
            foreach (char c in s)
            {
                if (c == '"') quoted = !quoted;
                else if (c == ',' && !quoted) { result.Add(cur.ToString()); cur.Clear(); }
                else cur.Append(c);
            }
            result.Add(cur.ToString());
            return result;
        }

        /// <summary>Lit un drapeau hexadécimal (0x511) ; 0 si le champ est absent ou illisible</summary>
        internal static long Flags(List<string> fields, int index)
        {
            if (index >= fields.Count) return 0;
            string s = fields[index].Trim();
            int i = 0;
            if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) i = 2;
            long value = 0;
            for (; i < s.Length && i < 18; i++)
            {
                int digit = Uri.IsHexDigit(s[i]) ? Convert.ToInt32(s[i].ToString(), 16) : -1;
                if (digit < 0) break;
                value = unchecked(value * 16 + digit);
            }
            return value;
        }

        /// <summary>Lit un champ de dégâts compté depuis la fin de la ligne. Les lignes de sorts ont un champ de plus à la fin.</summary>
        static long DamageField(string ev, List<string> f, int fromEnd)
        {
            int back = fromEnd + (ev.StartsWith("SPELL_", StringComparison.Ordinal) || ev.StartsWith("RANGE_", StringComparison.Ordinal) ? 1 : 0);
            long value;
            return f.Count >= back && long.TryParse(f[f.Count - back], NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out value) ? value : 0;
        }

        /// <summary>Surplus de dégâts d'un coup : positif si ce coup a tué sa cible</summary>
        static long Overkill(string ev, List<string> f) { return DamageField(ev, f, 8); }

        /// <summary>Dégâts d'un coup : 0 pour une ligne _MISSED, qui ne porte pas de montant</summary>
        internal static long Amount(string ev, List<string> f)
        {
            return ev.EndsWith("_DAMAGE", StringComparison.Ordinal) ? Math.Max(0, DamageField(ev, f, 10)) : 0;
        }

        internal static DateTime? LineTime(string line, int sep)
        {
            DateTime value;
            return DateTime.TryParse(line.Substring(0, sep), CultureInfo.InvariantCulture, DateTimeStyles.None, out value) ? value : (DateTime?)null;
        }

        // WoW écrit le log à la fin du combat. Une mort finit le combat : le coup mortel est écrit aussitôt,
        // mais le UNIT_DIED qui le suit de 2 ms n'arrive qu'à l'écriture suivante, plusieurs minutes après (mesuré : 198 s).
        // La mort part donc sur le coup mortel, et ce UNIT_DIED est reconnu à son heure pour ne pas la compter deux fois.
        const double SameDeathSeconds = 5;
        static DateTime? lastFatalAt; // lu et écrit par le seul fil de lecture du log

        static bool IsSameDeath(DateTime? time)
        {
            return time != null && lastFatalAt != null && Math.Abs((time.Value - lastFatalAt.Value).TotalSeconds) < SameDeathSeconds;
        }

        /// <summary>Ancienneté de la ligne en secondes, pour que la régie écarte ce que WoW écrit en retard. Bornée pour limiter la taille des envois.</summary>
        public static int AgeSeconds(string line)
        {
            int sep = line.IndexOf("  ", StringComparison.Ordinal);
            DateTime? time = sep < 0 ? null : LineTime(line, sep);
            if (time == null) return 0;
            return (int)Math.Min(60, Math.Max(0, Math.Round((DateTime.Now - time.Value).TotalSeconds)));
        }

        /// <summary>Renvoie le type d'événement de la ligne, ou null si elle n'intéresse pas la régie</summary>
        public static string Classify(string line)
        {
            int sep = line.IndexOf("  ", StringComparison.Ordinal);
            if (sep < 0) return null;
            List<string> f = SplitCsv(line.Substring(sep + 2).Trim());
            string ev = f[0];
            if (ev == "ENCOUNTER_START") return "boss_start";
            if (ev == "ENCOUNTER_END") return f.Count > 5 && f[5] == "1" ? "boss_kill" : "boss_wipe";
            long src = Flags(f, 3), dst = Flags(f, 7);
            if (ev.EndsWith("_DAMAGE", StringComparison.Ordinal) && MeExact(dst) && Overkill(ev, f) > 0)
            {
                lastFatalAt = LineTime(line, sep);
                return "death";
            }
            if (ev == "UNIT_DIED" && MeExact(dst)) return IsSameDeath(LineTime(line, sep)) ? null : "death";
            if (ev == "PARTY_KILL" && Me(src)) return "kill";
            if (ev == "SPELL_INTERRUPT" && Me(src)) return "interrupt";
            if (ev == "SPELL_RESURRECT" && (Me(src) || MeExact(dst))) return "res";
            if (ev.EndsWith("_DAMAGE", StringComparison.Ordinal) || ev.EndsWith("_MISSED", StringComparison.Ordinal))
            {
                if (Me(src)) return "dmg_out";
                if (MeExact(dst)) return "dmg_in";
                return null;
            }
            if ((ev == "SPELL_HEAL" || ev == "SPELL_PERIODIC_HEAL") && Me(src)) return "heal";
            if (ev == "SPELL_CAST_SUCCESS" && Me(src)) return "cast";
            return null;
        }
    }
}
