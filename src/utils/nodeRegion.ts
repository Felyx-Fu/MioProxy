import type { MessageKey } from "../locales/en-US";

export type NodeRegion =
  | "hk"
  | "tw"
  | "jp"
  | "sg"
  | "us"
  | "kr"
  | "uk"
  | "de"
  | "fr"
  | "ca"
  | "au"
  | "in"
  | "ru"
  | "nl"
  | "my"
  | "th"
  | "vn"
  | "ph"
  | "id"
  | "unknown";

export type NodeRegionInfo = {
  id: NodeRegion;
  flag: string | null;
  labelKey: MessageKey;
};

export const NODE_REGION_INFO = {
  hk: { id: "hk", flag: "🇭🇰", labelKey: "proxies.region.hk" },
  tw: { id: "tw", flag: "🇹🇼", labelKey: "proxies.region.tw" },
  jp: { id: "jp", flag: "🇯🇵", labelKey: "proxies.region.jp" },
  sg: { id: "sg", flag: "🇸🇬", labelKey: "proxies.region.sg" },
  us: { id: "us", flag: "🇺🇸", labelKey: "proxies.region.us" },
  kr: { id: "kr", flag: "🇰🇷", labelKey: "proxies.region.kr" },
  uk: { id: "uk", flag: "🇬🇧", labelKey: "proxies.region.uk" },
  de: { id: "de", flag: "🇩🇪", labelKey: "proxies.region.de" },
  fr: { id: "fr", flag: "🇫🇷", labelKey: "proxies.region.fr" },
  ca: { id: "ca", flag: "🇨🇦", labelKey: "proxies.region.ca" },
  au: { id: "au", flag: "🇦🇺", labelKey: "proxies.region.au" },
  in: { id: "in", flag: "🇮🇳", labelKey: "proxies.region.in" },
  ru: { id: "ru", flag: "🇷🇺", labelKey: "proxies.region.ru" },
  nl: { id: "nl", flag: "🇳🇱", labelKey: "proxies.region.nl" },
  my: { id: "my", flag: "🇲🇾", labelKey: "proxies.region.my" },
  th: { id: "th", flag: "🇹🇭", labelKey: "proxies.region.th" },
  vn: { id: "vn", flag: "🇻🇳", labelKey: "proxies.region.vn" },
  ph: { id: "ph", flag: "🇵🇭", labelKey: "proxies.region.ph" },
  id: { id: "id", flag: "🇮🇩", labelKey: "proxies.region.id" },
  unknown: { id: "unknown", flag: null, labelKey: "proxies.region.other" },
} satisfies Record<NodeRegion, NodeRegionInfo>;

export const NODE_REGION_IDS: readonly NodeRegion[] = [
  "hk", "tw", "jp", "sg", "us", "kr", "uk", "de", "fr", "ca",
  "au", "in", "ru", "nl", "my", "th", "vn", "ph", "id", "unknown",
];

type RegionMatcher = {
  id: Exclude<NodeRegion, "unknown">;
  local: readonly string[];
  english: readonly string[];
  codes: readonly string[];
};

const REGION_MATCHERS: readonly RegionMatcher[] = [
  { id: "hk", local: ["香港", "港"], english: ["hong kong", "hongkong"], codes: ["HK", "HKG"] },
  { id: "tw", local: ["台湾", "台灣"], english: ["taiwan"], codes: ["TW", "TPE"] },
  { id: "jp", local: ["日本"], english: ["japan"], codes: ["JP", "JPN"] },
  { id: "sg", local: ["新加坡", "狮城", "獅城"], english: ["singapore"], codes: ["SG", "SGP"] },
  { id: "us", local: ["美国", "美國"], english: ["united states", "unitedstates"], codes: ["US", "USA"] },
  { id: "kr", local: ["韩国", "韓國"], english: ["south korea", "southkorea", "korea"], codes: ["KR", "KOR"] },
  { id: "uk", local: ["英国", "英國"], english: ["united kingdom", "unitedkingdom"], codes: ["UK", "GB"] },
  { id: "de", local: ["德国", "德國"], english: ["germany"], codes: ["DE", "GER", "DEU"] },
  { id: "fr", local: ["法国", "法國"], english: ["france"], codes: ["FR", "FRA"] },
  { id: "ca", local: ["加拿大"], english: ["canada"], codes: ["CA", "CAN"] },
  { id: "au", local: ["澳大利亚", "澳大利亞", "澳洲"], english: ["australia"], codes: ["AU", "AUS"] },
  { id: "in", local: ["印度"], english: ["india"], codes: ["IN", "IND"] },
  { id: "ru", local: ["俄罗斯", "俄羅斯"], english: ["russia"], codes: ["RU", "RUS"] },
  { id: "nl", local: ["荷兰", "荷蘭"], english: ["netherlands"], codes: ["NL", "NLD"] },
  { id: "my", local: ["马来西亚", "馬來西亞"], english: ["malaysia"], codes: ["MY", "MYS"] },
  { id: "th", local: ["泰国", "泰國"], english: ["thailand"], codes: ["TH", "THA"] },
  { id: "vn", local: ["越南"], english: ["vietnam"], codes: ["VN", "VNM"] },
  { id: "ph", local: ["菲律宾", "菲律賓"], english: ["philippines"], codes: ["PH", "PHL"] },
  // Keep Indonesia ahead of India when matching local-language names: 印度尼西亚 contains 印度.
  { id: "id", local: ["印度尼西亚", "印度尼西亞"], english: ["indonesia"], codes: ["ID", "IDN"] },
];

const UNKNOWN_REGION_INFO = NODE_REGION_INFO.unknown;

function findPhraseMatch(name: string, field: "local" | "english") {
  const candidates = REGION_MATCHERS.flatMap((matcher, matcherIndex) =>
    matcher[field].map((token) => ({ id: matcher.id, token, matcherIndex })),
  ).sort((a, b) => b.token.length - a.token.length || a.matcherIndex - b.matcherIndex);
  return candidates.find(({ token }) => name.includes(token))?.id;
}

function hasCodeToken(name: string, code: string) {
  // Node names commonly put numbers, underscores, emoji, or punctuation beside a code.
  // Restrict the boundary to ASCII letters so a code cannot be extracted from a word.
  return new RegExp(`(?:^|[^A-Z])${code}(?=$|[^A-Z])`).test(name);
}

function findCodeMatch(name: string) {
  for (const matcher of REGION_MATCHERS) {
    if (matcher.codes.some((code) => hasCodeToken(name, code))) return matcher.id;
  }
  return undefined;
}

export function classifyNodeRegion(nodeName: string): NodeRegionInfo {
  const normalized = nodeName.normalize("NFKC");

  for (const matcher of REGION_MATCHERS) {
    if (NODE_REGION_INFO[matcher.id].flag && normalized.includes(NODE_REGION_INFO[matcher.id].flag!)) {
      return NODE_REGION_INFO[matcher.id];
    }
  }

  const localName = findPhraseMatch(normalized, "local");
  if (localName) return NODE_REGION_INFO[localName];

  const englishName = findPhraseMatch(normalized.toLocaleLowerCase("en-US"), "english");
  if (englishName) return NODE_REGION_INFO[englishName];

  const codeName = findCodeMatch(normalized.toLocaleUpperCase("en-US"));
  if (codeName) return NODE_REGION_INFO[codeName];

  return UNKNOWN_REGION_INFO;
}
