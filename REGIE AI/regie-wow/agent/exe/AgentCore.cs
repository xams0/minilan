// Suit le combat log en arrière-plan et envoie les événements à la régie (POST /api/agent).
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace AgentRegie
{
    public class PlayerInfo
    {
        public int Index;
        public string Name;
        public override string ToString() { return (Index + 1) + " · " + Name; }
    }

    public class AgentStatus
    {
        public bool Running;
        public bool Connected;
        public DateTime? LastSentAt;
        public string Error;
        public string LogFile;
        public DateTime? LastDataAt;
        public long Sent;
        public string LastKind;
        public DateTime? LastKindAt;
    }

    public static class RegieApi
    {
        /// <summary>Accepte 192.168.1.31:8081 aussi bien que http://192.168.1.31:8081/</summary>
        public static string Normalize(string address)
        {
            string s = (address ?? "").Trim().TrimEnd('/');
            if (s.Length == 0) return "";
            return s.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || s.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ? s : "http://" + s;
        }

        static HttpWebRequest Create(string url, string method)
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = method;
            req.Timeout = 3000;
            req.ReadWriteTimeout = 3000;
            req.Proxy = null; // réseau local : pas de proxy, et pas d'attente de sa détection
            req.ServicePoint.Expect100Continue = false;
            return req;
        }

        public static List<PlayerInfo> ReadPlayers(string server)
        {
            using (var res = (HttpWebResponse)Create(server + "/api/state", "GET").GetResponse())
            using (var reader = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
            {
                var json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
                var state = json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                var players = (System.Collections.ArrayList)state["players"];
                return players.Cast<Dictionary<string, object>>()
                    .Select(p => new PlayerInfo { Index = Convert.ToInt32(p["i"]), Name = Convert.ToString(p["name"]) })
                    .OrderBy(p => p.Index).ToList();
            }
        }

        public static void Send(string server, int player, IEnumerable<KeyValuePair<Tuple<string, int>, int>> events)
        {
            var body = new StringBuilder();
            body.Append("{\"player\":").Append(player).Append(",\"events\":[");
            body.Append(string.Join(",", events.Select(e => "{\"kind\":\"" + e.Key.Item1 + "\",\"age\":" + e.Key.Item2 + ",\"n\":" + e.Value + "}")));
            body.Append("]}");
            byte[] data = Encoding.UTF8.GetBytes(body.ToString());

            HttpWebRequest req = Create(server + "/api/agent", "POST");
            req.ContentType = "application/json";
            req.ContentLength = data.Length;
            using (Stream s = req.GetRequestStream()) s.Write(data, 0, data.Length);
            using (req.GetResponse()) { }
        }
    }

    public class AgentCore
    {
        const int MaxChunk = 4 * 1024 * 1024;

        readonly string server;
        readonly int player;
        readonly string logsFolder;
        readonly DateTime startedAtUtc = DateTime.UtcNow;
        readonly object gate = new object();
        readonly Dictionary<Tuple<string, int>, int> pending = new Dictionary<Tuple<string, int>, int>(); // (type, âge en secondes) → nombre
        readonly AgentStatus status = new AgentStatus { Running = true };
        readonly Journal journal = new Journal();
        readonly List<JournalEntry> journalEntries = new List<JournalEntry>();
        volatile bool stopping;

        string file;
        long position;
        string rest = "";
        Decoder decoder;

        public AgentCore(string server, int player, string logsFolder)
        {
            this.server = server;
            this.player = player;
            this.logsFolder = logsFolder;
        }

        public void Start()
        {
            new Thread(ReadLoop) { IsBackground = true, Name = "lecture du log" }.Start();
            new Thread(SendLoop) { IsBackground = true, Name = "envoi" }.Start();
        }

        public void Stop()
        {
            stopping = true;
            lock (gate) status.Running = false;
        }

        /// <summary>Les entrées du journal apparues depuis le dernier appel</summary>
        public List<JournalEntry> TakeJournal()
        {
            lock (gate)
            {
                List<JournalEntry> taken = journalEntries.ToList();
                journalEntries.Clear();
                return taken;
            }
        }

        public AgentStatus Snapshot()
        {
            lock (gate)
            {
                return new AgentStatus
                {
                    Running = status.Running, Connected = status.Connected, LastSentAt = status.LastSentAt, Error = status.Error,
                    LogFile = status.LogFile, LastDataAt = status.LastDataAt, Sent = status.Sent,
                    LastKind = status.LastKind, LastKindAt = status.LastKindAt
                };
            }
        }

        void ReadLoop()
        {
            int tick = 0;
            while (!stopping)
            {
                try
                {
                    if (tick++ % 5 == 0) PickFile(); // la liste des fichiers n'a pas besoin d'être relue à chaque tour
                    ReadNewLines();
                }
                catch (Exception)
                {
                    // Erreur passagère : on garde la position, sinon le log serait relu et renvoyé depuis son début
                    if (file != null && !File.Exists(file)) { file = null; lock (gate) status.LogFile = null; }
                }
                Thread.Sleep(400);
            }
        }

        void PickFile()
        {
            FileInfo newest = LogFinder.NewestLog(logsFolder);
            if (newest == null || newest.FullName == file) return;
            ReadNewLines(); // la fin de l'ancien log, écrite depuis le dernier tour
            bool first = file == null;
            file = newest.FullName;
            rest = "";
            decoder = Encoding.UTF8.GetDecoder();
            // Log déjà là au lancement : on part de la fin pour ne pas rejouer le passé.
            // Log créé depuis (nouveau /combatlog) : tout son contenu est récent.
            position = newest.CreationTimeUtc >= startedAtUtc ? 0 : OpenLength(file);
            lock (gate)
            {
                status.LogFile = newest.Name;
                journalEntries.Add(new JournalEntry("LOG", DateTime.Now).Text((first ? "Lecture de " : "Nouveau fichier : ") + newest.Name));
            }
        }

        static FileStream OpenShared(string path)
        {
            return new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        }

        // La taille vue à travers le fichier ouvert est exacte, contrairement à celle de l'annuaire pendant que WoW écrit
        static long OpenLength(string path)
        {
            using (FileStream fs = OpenShared(path)) return fs.Length;
        }

        void ReadNewLines()
        {
            if (file == null) return;
            using (FileStream fs = OpenShared(file))
            {
                long length = fs.Length;
                if (length < position) { position = 0; rest = ""; decoder.Reset(); }
                if (length == position) return;

                int count = (int)Math.Min(length - position, MaxChunk);
                var buffer = new byte[count];
                fs.Seek(position, SeekOrigin.Begin);
                int read = fs.Read(buffer, 0, count);
                position += read;

                var chars = new char[decoder.GetCharCount(buffer, 0, read)];
                int n = decoder.GetChars(buffer, 0, read, chars, 0);
                string[] lines = (rest + new string(chars, 0, n)).Split('\n');
                rest = lines[lines.Length - 1];

                lock (gate)
                {
                    status.LastDataAt = DateTime.Now;
                    for (int i = 0; i < lines.Length - 1; i++)
                    {
                        string line = lines[i].TrimEnd('\r');
                        string kind = CombatLog.Classify(line);
                        journal.Read(line, kind, journalEntries);
                        if (kind == null) continue;
                        var key = Tuple.Create(kind, CombatLog.AgeSeconds(line));
                        int current;
                        pending.TryGetValue(key, out current);
                        pending[key] = current + 1;
                        status.LastKind = kind;
                        status.LastKindAt = DateTime.Now;
                    }
                    journal.EndOfBatch(journalEntries);
                }
            }
        }

        void SendLoop()
        {
            DateTime lastSend = DateTime.MinValue;
            while (!stopping)
            {
                List<KeyValuePair<Tuple<string, int>, int>> events;
                lock (gate)
                {
                    events = pending.ToList();
                    pending.Clear();
                }
                // Sans événement, un message toutes les 5 s dit à la régie que l'agent est toujours là
                if (events.Count > 0 || (DateTime.Now - lastSend).TotalSeconds >= 5)
                {
                    lastSend = DateTime.Now;
                    try
                    {
                        RegieApi.Send(server, player, events);
                        lock (gate)
                        {
                            status.Connected = true;
                            status.Error = null;
                            status.LastSentAt = DateTime.Now;
                            status.Sent += events.Sum(e => e.Value);
                        }
                    }
                    catch (Exception e)
                    {
                        lock (gate) { status.Connected = false; status.Error = e.Message; }
                    }
                }
                Thread.Sleep(500);
            }
        }
    }
}
