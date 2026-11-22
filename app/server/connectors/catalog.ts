// A curated list of feeds worth adding in one tap. Every URL was fetched and parsed with parseFeed (tools/check-catalog.ts).
export type CatalogEntry = { name: string; site: string; feed: string; lang: "de" | "en"; about: string };
export type CatalogGroup = { id: string; title: string; entries: CatalogEntry[] };

export const CATALOG: CatalogGroup[] = [
  { id: "munich", title: "München & Bayern", entries: [
    { name: "SZ München", site: "sueddeutsche.de", feed: "https://rss.sueddeutsche.de/rss/Muenchen", lang: "de", about: "Süddeutsche Zeitung, local news from Munich" },
    { name: "SZ Bayern", site: "sueddeutsche.de", feed: "https://rss.sueddeutsche.de/rss/Bayern", lang: "de", about: "Süddeutsche Zeitung, news from Bavaria" },
    { name: "tz München", site: "tz.de", feed: "https://www.tz.de/muenchen/rssfeed.rdf", lang: "de", about: "Munich tabloid: city, crime, FC Bayern" },
    { name: "Tagesschau Bayern", site: "tagesschau.de", feed: "https://www.tagesschau.de/inland/regional/bayern/index~rss2.xml", lang: "de", about: "ARD regional news from Bavaria" },
    { name: "MUCBOOK", site: "mucbook.de", feed: "https://www.mucbook.de/feed/", lang: "de", about: "Munich lifestyle, food and events" },
  ] },
  { id: "germany", title: "Deutschland", entries: [
    { name: "Tagesschau", site: "tagesschau.de", feed: "https://www.tagesschau.de/index~rss2.xml", lang: "de", about: "ARD news, the national front page" },
    { name: "Spiegel", site: "spiegel.de", feed: "https://www.spiegel.de/schlagzeilen/index.rss", lang: "de", about: "Headlines from Der Spiegel" },
    { name: "ZEIT ONLINE", site: "zeit.de", feed: "https://newsfeed.zeit.de/index", lang: "de", about: "Die Zeit, politics and society" },
    { name: "FAZ", site: "faz.net", feed: "https://www.faz.net/rss/aktuell/", lang: "de", about: "Frankfurter Allgemeine, latest articles" },
    { name: "Deutschlandfunk", site: "deutschlandfunk.de", feed: "https://www.deutschlandfunk.de/nachrichten-100.rss", lang: "de", about: "Public radio news" },
  ] },
  { id: "tech", title: "Tech", entries: [
    { name: "heise online", site: "heise.de", feed: "https://www.heise.de/rss/heise-atom.xml", lang: "de", about: "German IT news" },
    { name: "Golem.de", site: "golem.de", feed: "https://rss.golem.de/rss.php?feed=RSS2.0", lang: "de", about: "IT and tech news from Germany" },
    { name: "netzpolitik.org", site: "netzpolitik.org", feed: "https://netzpolitik.org/feed/", lang: "de", about: "Digital rights, surveillance, policy" },
    { name: "Ars Technica", site: "arstechnica.com", feed: "https://feeds.arstechnica.com/arstechnica/index", lang: "en", about: "In-depth tech and science reporting" },
    { name: "The Verge", site: "theverge.com", feed: "https://www.theverge.com/rss/index.xml", lang: "en", about: "Consumer tech, culture and policy" },
    { name: "TechCrunch", site: "techcrunch.com", feed: "https://techcrunch.com/feed/", lang: "en", about: "Startups and venture funding" },
  ] },
  { id: "ai", title: "AI", entries: [
    { name: "Simon Willison", site: "simonwillison.net", feed: "https://simonwillison.net/atom/everything/", lang: "en", about: "Hands-on notes on LLMs and tooling" },
    { name: "Import AI", site: "importai.substack.com", feed: "https://importai.substack.com/feed", lang: "en", about: "Weekly AI research digest by Jack Clark" },
    { name: "OpenAI News", site: "openai.com", feed: "https://openai.com/news/rss.xml", lang: "en", about: "Announcements from OpenAI" },
    { name: "Google DeepMind", site: "deepmind.google", feed: "https://deepmind.google/blog/rss.xml", lang: "en", about: "Research and product posts" },
    { name: "Hugging Face Blog", site: "huggingface.co", feed: "https://huggingface.co/blog/feed.xml", lang: "en", about: "Open models and tooling" },
    { name: "MIT Technology Review AI", site: "technologyreview.com", feed: "https://www.technologyreview.com/topic/artificial-intelligence/feed", lang: "en", about: "Reporting on AI and its limits" },
  ] },
  { id: "business", title: "Wirtschaft", entries: [
    { name: "Handelsblatt", site: "handelsblatt.com", feed: "https://www.handelsblatt.com/contentexport/feed/schlagzeilen", lang: "de", about: "German business daily, headlines" },
    { name: "manager magazin", site: "manager-magazin.de", feed: "https://www.manager-magazin.de/index.rss", lang: "de", about: "Companies, management, markets" },
    { name: "WirtschaftsWoche", site: "wiwo.de", feed: "https://www.wiwo.de/contentexport/feed/rss/schlagzeilen", lang: "de", about: "Business weekly, headlines" },
    { name: "Tagesschau Wirtschaft", site: "tagesschau.de", feed: "https://www.tagesschau.de/wirtschaft/index~rss2.xml", lang: "de", about: "ARD business news" },
    { name: "Financial Times", site: "ft.com", feed: "https://www.ft.com/rss/home", lang: "en", about: "Global business, headlines only" },
    { name: "The Economist", site: "economist.com", feed: "https://www.economist.com/finance-and-economics/rss.xml", lang: "en", about: "Finance and economics section" },
  ] },
];
