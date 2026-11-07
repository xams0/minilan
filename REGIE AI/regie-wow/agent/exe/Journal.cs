// Journal lisible des moments importants du log, affiché dans la fenêtre pour vérifier ce que l'agent reconnaît.
// Morts, kills, boss, interruptions et résurrections suivent CombatLog.Classify : c'est ce qui part à la régie.
// PvP, zones, BG et combats sont des indications de lecture : ils ne changent rien à ce qui est envoyé.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;

namespace AgentRegie
{
    public enum PartKind { Text, Self, OtherPlayer }

    public class JournalPart
    {
        public string Text;
        public PartKind Kind;
    }

    public class JournalEntry
    {
        public string Tag;
        public DateTime? LogTime;
        public readonly DateTime ReadAt = DateTime.Now;
        public readonly List<JournalPart> Parts = new List<JournalPart>();

        public JournalEntry(string tag, DateTime? logTime) { Tag = tag; LogTime = logTime; }

        public JournalEntry Text(string text) { Parts.Add(new JournalPart { Text = text, Kind = PartKind.Text }); return this; }
        public JournalEntry Self(string name) { Parts.Add(new JournalPart { Text = name, Kind = PartKind.Self }); return this; }
        public JournalEntry Other(string name) { Parts.Add(new JournalPart { Text = name, Kind = PartKind.OtherPlayer }); return this; }

        public override string ToString()
        {
            return (LogTime != null ? LogTime.Value.ToString("HH:mm:ss") : "--:--:--") + " " + Tag + " " + string.Concat(Parts.Select(p => p.Text));
        }
    }

    public class Journal
    {
        const long AffiliationGroup = 0x6, ReactionHostile = 0x40;
        const double FightGapSeconds = 10;

        // Identifiants d'instance des champs de bataille et arènes, à compléter si le journal en affiche un en INSTANCE
        static readonly HashSet<string> Battlegrounds = new HashSet<string> { "30", "489", "529", "566", "607", "628", "726", "727", "761", "968", "998", "1105", "1280", "1681", "1803", "2106", "2107", "2118" };
        static readonly HashSet<string> Arenas = new HashSet<string> { "559", "562", "572", "617", "618", "980", "1134", "1504", "1505", "1552", "1672", "1825", "1911" };
        // Continents : tout autre identifiant est une instance
        static readonly HashSet<string> Continents = new HashSet<string> { "0", "1", "530", "571", "646", "730", "860", "870", "1116", "1220", "1464", "1643", "2222", "2444", "2552" };

        static readonly Dictionary<string, string> Environments = new Dictionary<string, string>
        {
            { "Falling", "une chute" }, { "Drowning", "la noyade" }, { "Fatigue", "la fatigue" }, { "Fire", "le feu" }, { "Lava", "la lave" }, { "Slime", "la vase" }
        };

        class Fight
        {
            public DateTime? First, Last;
            public long Dealt, Taken;
            public bool Pvp;
            public readonly Dictionary<string, int> Enemies = new Dictionary<string, int>();
        }

        string self;
        string zone;
        Fight fight;

        static string ShortName(string name)
        {
            int dash = name.IndexOf('-');
            return dash > 0 ? name.Substring(0, dash) : name;
        }

        static bool IsPlayer(long flags) { return (flags & 0x400) != 0; }
        static bool IsHostilePlayer(long flags) { return IsPlayer(flags) && (flags & ReactionHostile) != 0; }

        JournalEntry Name(JournalEntry e, string name, long flags)
        {
            if (name == "nil" || name.Length == 0) return e.Text("?");
            if (CombatLog.MeExact(flags)) return e.Self(ShortName(name));
            if (IsPlayer(flags)) return e.Other(ShortName(name));
            if (CombatLog.Me(flags)) return e.Text(name + " (familier)");
            return e.Text(name);
        }

        /// <summary>Lit une ligne. kind est le résultat de CombatLog.Classify pour cette même ligne.</summary>
        public void Read(string line, string kind, List<JournalEntry> into)
        {
            int sep = line.IndexOf("  ", StringComparison.Ordinal);
            if (sep < 0) return;
            List<string> f = CombatLog.SplitCsv(line.Substring(sep + 2).Trim());
            string ev = f[0];
            DateTime? time = CombatLog.LineTime(line, sep);

            if (ev == "ZONE_CHANGE") { ReadZone(f, time, into); return; }
            if (kind == "boss_start") { into.Add(new JournalEntry("BOSS", time).Text("Pull : " + Field(f, 2))); return; }
            if (kind == "boss_kill") { into.Add(new JournalEntry("BOSS", time).Text(Field(f, 2) + " tombé")); return; }
            if (kind == "boss_wipe") { into.Add(new JournalEntry("BOSS", time).Text("Wipe sur " + Field(f, 2))); return; }
            if (f.Count < 8) return;

            long src = CombatLog.Flags(f, 3), dst = CombatLog.Flags(f, 7);
            string srcName = f[2], dstName = f[6];
            NoteCharacter(CombatLog.MeExact(src) ? srcName : CombatLog.MeExact(dst) ? dstName : null, time, into);

            if (kind == "death")
            {
                // Un coup mortel, ou un UNIT_DIED sans coup mortel vu (Classify écarte le UNIT_DIED tardif d'une mort déjà signalée)
                JournalEntry e = Name(new JournalEntry("MORT", time), dstName, dst);
                if (ev == "UNIT_DIED") e.Text(" est mort(e)");
                else if (ev == "ENVIRONMENTAL_DAMAGE") e.Text(" tué(e) par " + EnvironmentOf(f));
                else Name(e.Text(" tué(e) par "), srcName, src);
                EndFight(into);
                into.Add(e);
            }
            else if (kind == "kill") into.Add(Name(Name(new JournalEntry(IsHostilePlayer(dst) ? "PVP" : "KILL", time), srcName, src).Text(" a tué "), dstName, dst));
            else if (kind == "interrupt") into.Add(Name(Name(new JournalEntry("INTERRUPTION", time), srcName, src).Text(" a interrompu "), dstName, dst).Text(f.Count > 13 ? " (" + f[13] + ")" : ""));
            else if (kind == "res") into.Add(Name(Name(new JournalEntry("RÉSURRECTION", time), srcName, src).Text(" a ressuscité "), dstName, dst));
            else if (kind == "dmg_out" || kind == "dmg_in") AddToFight(ev, f, kind == "dmg_out", srcName, src, dstName, dst, time, into);
            else if (ev == "UNIT_DIED" && IsPlayer(dst) && (dst & AffiliationGroup) != 0) into.Add(Name(new JournalEntry("MORT", time), dstName, dst).Text(" est mort(e) (groupe)"));
        }

        /// <summary>WoW vient d'écrire : le combat en cours de lecture est fini</summary>
        public void EndOfBatch(List<JournalEntry> into) { EndFight(into); }

        static string Field(List<string> f, int i) { return i < f.Count ? f[i] : "?"; }

        static string EnvironmentOf(List<string> f)
        {
            string type = Field(f, f.Count - 11), label;
            return Environments.TryGetValue(type, out label) ? label : type;
        }

        void NoteCharacter(string name, DateTime? time, List<JournalEntry> into)
        {
            if (name == null || name == self) return;
            EndFight(into); // sous le nom du personnage qui l'a mené
            self = name;
            into.Add(new JournalEntry("PERSONNAGE", time).Self(ShortName(name)));
        }

        void ReadZone(List<string> f, DateTime? time, List<JournalEntry> into)
        {
            string id = Field(f, 1), name = Field(f, 2), key = id + "|" + name;
            if (key == zone) return;
            zone = key;
            EndFight(into);
            string tag = Battlegrounds.Contains(id) ? "BG" : Arenas.Contains(id) ? "ARÈNE" : Continents.Contains(id) ? "ZONE" : "INSTANCE";
            into.Add(new JournalEntry(tag, time).Text(name + " (id " + id + ")"));
        }

        void AddToFight(string ev, List<string> f, bool dealt, string srcName, long src, string dstName, long dst, DateTime? time, List<JournalEntry> into)
        {
            if (fight != null && time != null && fight.Last != null && (time.Value - fight.Last.Value).TotalSeconds > FightGapSeconds) EndFight(into);
            if (fight == null) fight = new Fight { First = time };
            fight.Last = time;

            long amount = CombatLog.Amount(ev, f);
            if (dealt) fight.Dealt += amount; else fight.Taken += amount;

            long enemyFlags = dealt ? dst : src;
            string enemy = dealt ? dstName : srcName;
            if (IsPlayer(enemyFlags)) enemy = ShortName(enemy); // retire le royaume d'un joueur ; un mob peut avoir un tiret dans son nom
            if (IsHostilePlayer(enemyFlags)) fight.Pvp = true;
            if (enemy != "nil" && enemy.Length > 0)
            {
                int hits;
                fight.Enemies.TryGetValue(enemy, out hits);
                fight.Enemies[enemy] = hits + 1;
            }
        }

        void EndFight(List<JournalEntry> into)
        {
            if (fight == null) return;
            Fight done = fight;
            fight = null;

            var e = new JournalEntry(done.Pvp ? "PVP" : "COMBAT", done.Last);
            if (self != null) e.Self(ShortName(self)).Text(" · ");
            double seconds = done.First != null && done.Last != null ? (done.Last.Value - done.First.Value).TotalSeconds : 0;
            e.Text(Math.Round(seconds).ToString(CultureInfo.InvariantCulture) + " s");
            if (done.Enemies.Count > 0)
            {
                string main = done.Enemies.OrderByDescending(p => p.Value).First().Key;
                e.Text(" contre " + main + (done.Enemies.Count > 1 ? " (+" + (done.Enemies.Count - 1) + ")" : ""));
            }
            e.Text(" · " + done.Dealt + " infligés, " + done.Taken + " subis");
            into.Add(e);
        }
    }
}
