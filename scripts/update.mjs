import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const statePath = path.join(root, 'data/state.json');
const siteDir = path.join(root, 'site');
const articleDir = path.join(siteDir, 'articles');

const parts = Object.fromEntries(new Intl.DateTimeFormat('en', {
  timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit',
}).formatToParts(new Date()).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
const today = `${parts.year}-${parts.month}-${parts.day}`;
const displayDate = `${parts.year}年${parts.month}月${parts.day}日`;

const sources = [
  {
    id: 'amazon', name: '亚马逊卖家论坛', category: 'amazon', evidence: '平台论坛线索',
    url: 'https://r.jina.ai/https://sellercentral.amazon.com/seller-forums/discussions?sort=latest',
    path: /sellercentral\.amazon\.com\/seller-forums\/discussions\/t\//i,
    relevant: /seller central|policy|listing|title|fba|fbm|fee|advert|\bai\b|delivery|account|mandatory|navigation/i,
  },
  {
    id: 'ustr', name: '美国贸易代表办公室', category: 'tax', evidence: '官方一手',
    url: 'https://r.jina.ai/https://ustr.gov/about-us/policy-offices/press-office/press-releases',
    path: /ustr\.gov\/about\/policy-offices\/press-office\/press-releases\/\d{4}\//i,
    relevant: /tariff|trade|custom|section 301|forced labor|china|european union|de minimis|import|export/i,
  },
  {
    id: 'cbp', name: '美国海关与边境保护局', category: 'tax', evidence: '官方一手',
    url: 'https://r.jina.ai/https://www.cbp.gov/newsroom',
    path: /cbp\.gov\/newsroom\/(?:national|local)-media-release\//i,
    relevant: /tariff|custom|import|export|e-commerce|de minimis|shipment|cargo|trade|forced labor/i,
  },
  {
    id: 'eu-taxud', name: '欧盟税务与关税总司', category: 'tax', evidence: '官方一手',
    url: 'https://r.jina.ai/https://taxation-customs.ec.europa.eu/news_en',
    path: /taxation-customs\.ec\.europa\.eu\/news\//i,
    relevant: /vat|custom|e-commerce|cbam|epr|tax|import|control/i,
  },
  {
    id: 'shenzhen', name: '深圳海关', category: 'logistics', evidence: '官方一手',
    url: 'https://r.jina.ai/http://shenzhen.customs.gov.cn/shenzhen_customs/511680/511681/index.html',
    path: /shenzhen\.customs\.gov\.cn\/.*\.html/i,
    relevant: /查验|海关|跨境|出口|进口|口岸|物流|关税|报关|监管|通关/,
  },
  {
    id: 'maersk', name: '马士基', category: 'logistics', evidence: '承运人一手',
    url: 'https://r.jina.ai/https://www.maersk.com/news',
    path: /maersk\.com\/news\/articles\/\d{4}\//i,
    relevant: /market update|schedule|blank sailing|port|surcharge|custom|tariff|disruption|strike|red sea|asia|china|europe|united states/i,
  },
];

const federalRegister = {
  id: 'federal-register', name: '美国联邦公报', category: 'tax', evidence: '官方一手',
  url: 'https://www.federalregister.gov/api/v1/documents.json?per_page=20&order=newest&conditions%5Bagencies%5D%5B%5D=u-s-customs-and-border-protection',
  relevant: /tariff|custom|import|export|trade|de minimis|forced labor|section 301/i,
};

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const cleanTitle = value => value.replace(/[*_`]/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

function dateFromUrl(url) {
  const match = url.match(/\/(20\d{2})\/(\d{2})\/(\d{2})\//) || url.match(/(20\d{2})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function ageInDays(date) {
  return date ? (Date.now() - Date.parse(`${date}T00:00:00+08:00`)) / 864e5 : null;
}

function markdownItems(text, source) {
  const items = [];
  const seen = new Set();
  const links = text.matchAll(/\[([^\]]{3,260})\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g);
  for (const match of links) {
    if (match.index > 0 && text[match.index - 1] === '!') continue;
    const title = cleanTitle(match[1]);
    const url = match[2].replace(/&amp;/g, '&');
    if (!source.path.test(url) || !source.relevant.test(title) || seen.has(url)) continue;
    seen.add(url);
    items.push({ title, url, date: dateFromUrl(url), sourceId: source.id, source: source.name, category: source.category, evidence: source.evidence });
    if (items.length >= 16) break;
  }
  return items;
}

async function getState() {
  try { return JSON.parse(await readFile(statePath, 'utf8')); }
  catch { return { seen: [], initializedSources: [], lastRun: null }; }
}

async function collect() {
  const results = await Promise.all(sources.map(async source => {
    try {
      const response = await fetch(source.url, { headers: { 'user-agent': 'amazon-risk-radar/1.0' }, signal: AbortSignal.timeout(25000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const items = markdownItems(await response.text(), source);
      return { source, ok: true, items };
    } catch (error) {
      return { source, ok: false, items: [], error: error.message };
    }
  }));

  try {
    const response = await fetch(federalRegister.url, { headers: { 'user-agent': 'amazon-risk-radar/1.0' }, signal: AbortSignal.timeout(25000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const items = (data.results || []).filter(item => federalRegister.relevant.test(`${item.title} ${item.abstract || ''}`)).map(item => ({
      title: cleanTitle(item.title), url: item.html_url, date: item.publication_date, sourceId: federalRegister.id,
      source: federalRegister.name, category: federalRegister.category, evidence: federalRegister.evidence,
    }));
    results.push({ source: federalRegister, ok: true, items });
  } catch (error) {
    results.push({ source: federalRegister, ok: false, items: [], error: error.message });
  }
  return results;
}

function isFreshCandidate(item, seen, initializedSources) {
  if (seen.has(item.url) || !initializedSources.has(item.sourceId)) return false;
  const age = ageInDays(item.date);
  return age === null || (age >= -1 && age <= 2.5);
}

if (process.argv.includes('--self-test')) {
  const seen = new Set(['seen']);
  const initialized = new Set(['ready']);
  console.assert(isFreshCandidate({ url: 'new', sourceId: 'ready', date: today }, seen, initialized));
  console.assert(!isFreshCandidate({ url: 'seen', sourceId: 'ready', date: today }, seen, initialized));
  console.assert(!isFreshCandidate({ url: 'new', sourceId: 'recovering', date: today }, seen, initialized));
  console.assert(!isFreshCandidate({ url: 'old', sourceId: 'ready', date: '2020-01-01' }, seen, initialized));
  console.log('增量筛选检查通过');
  process.exit(0);
}

const state = await getState();
const collected = await collect();
const candidates = [...new Map(collected.flatMap(result => result.items).map(item => [item.url, item])).values()];
const seen = new Set(state.seen || []);
const initializedSources = new Set(state.initializedSources || []);
const fresh = candidates.filter(item => isFreshCandidate(item, seen, initializedSources)).slice(0, 12);

const groups = [
  ['amazon', '亚马逊政策'], ['tax', '税务与关税'], ['logistics', '物流与查验'],
].map(([key, label]) => ({ key, label, items: fresh.filter(item => item.category === key) }));

const actions = {
  amazon: '核对适用站点与 ASIN，确认是否需要修改 Listing、广告或履约设置。',
  tax: '让税务或合规负责人核对适用国家、生效日期和申报影响。',
  logistics: '让货代核对相关口岸、航线、货类和未来两周时效。',
};

const stillWatching = [
  ['美国站旺季入仓节点', '美国站 FBA', '9月16日前', '确认活动库存是否已在途或已预约。', 'https://sellercentral.amazon.com/seller-forums/discussions/t/3e31fbb7-04e0-4ed4-873e-f74b1052e2ff'],
  ['非媒体类标题最多 75 字符', '亚马逊非媒体类商品', '已生效', '抽查主力 ASIN，将材料和用途移至 Item Highlights。', 'https://sellercentral.amazon.com/seller-forums/discussions/t/145b6d0f-999c-4555-896c-c694bda2e470'],
  ['逼真 AI 人物素材必须标记', '亚马逊全球站点', '已生效', '上传前写入 contains-synthetic-performer 元数据。', 'https://sellercentral.amazon.com/seller-forums/discussions/t/aa0aee06-aff4-497a-a4b6-9b2ebe06f715'],
  ['FBM 营业时间送达率 ≥ 90%', '美国站 Amazon Business', '9月30日起', '检查 14 天滚动指标与承诺时效。', 'https://sellercentral.amazon.com/seller-forums/discussions/t/57222b70-40df-4574-aa0f-9f815c197987'],
  ['黄金周 TP8 / TP12 停航', '跨太平洋相关订舱', '10月9日', '准备提前发运或替代航线。', 'https://www.maersk.com/news/articles/2026/08/28/transpacific-schedule-adjustments-golden-week-2026'],
];

const css = `
:root{--ink:#172033;--muted:#657086;--line:#dfe4ec;--paper:#fff;--canvas:#f3f5f8;--blue:#2563eb;--red:#c93838;--amber:#a65f00;--green:#187354}*{box-sizing:border-box}html{background:var(--canvas)}body{margin:0;color:var(--ink);font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}a{color:var(--blue);text-underline-offset:3px}.top{background:#091a34;color:#fff}.nav{display:flex;justify-content:space-between;gap:18px;width:min(1080px,calc(100% - 32px));margin:auto;padding:16px 0}.nav a{color:#fff;text-decoration:none}.nav span{color:#ffffffa6}.hero{padding:54px 0 48px;background:linear-gradient(135deg,#0d1b34,#173865 72%,#245b94)}.wrap{width:min(960px,calc(100% - 28px));margin:auto}.kicker{margin:0 0 9px;color:#a9d0ff;font-size:12px;font-weight:700;letter-spacing:.12em}.hero h1{max-width:780px;margin:0;font-size:clamp(30px,5vw,50px);line-height:1.12}.hero p{max-width:720px;color:#ffffffc8}.meta{display:flex;flex-wrap:wrap;gap:9px;color:#657086;font-size:13px}.hero .meta{color:#ffffffa6}.content{display:grid;grid-template-columns:minmax(0,1fr) 245px;gap:26px;padding:30px 0 56px}.card{margin-bottom:18px;padding:clamp(22px,4vw,34px);border:1px solid var(--line);border-radius:18px;background:var(--paper);box-shadow:0 10px 30px #10213f0c}.verdict{border-left:4px solid var(--amber);background:#fff9ef}.card h2{margin:0 0 14px;font-size:23px}.card h3{margin:0 0 5px;font-size:18px}.item{padding:18px 0;border-bottom:1px solid #edf0f4}.item:last-child{padding-bottom:0;border:0}.item p{margin:0 0 7px;color:var(--muted)}.badge{display:inline-block;margin-bottom:7px;padding:4px 9px;border-radius:999px;background:#fff0f0;color:var(--red);font-size:12px;font-weight:700}.watch{background:#fff7e8;color:var(--amber)}.ok{background:#eaf8f2;color:var(--green)}.aside{align-self:start;position:sticky;top:18px}.aside ul{margin:0;padding-left:18px;color:var(--muted)}.source-row{display:flex;justify-content:space-between;gap:14px;padding:10px 0;border-bottom:1px solid #edf0f4}.source-row small{color:var(--muted)}.archive a{display:flex;justify-content:space-between;gap:20px;padding:14px 0;border-bottom:1px solid #edf0f4;text-decoration:none}.archive a span:last-child{color:var(--muted)}footer{padding:0 14px 34px;text-align:center;color:var(--muted);font-size:13px}@media(max-width:720px){.content{grid-template-columns:1fr}.aside{position:static;order:-1}.nav{align-items:flex-start;flex-direction:column}.source-row,.archive a{align-items:flex-start;flex-direction:column;gap:2px}}@media print{html{background:#fff}.top{print-color-adjust:exact}.content{display:block}.aside{position:static}.card{box-shadow:none;break-inside:avoid}}
`;

function newItemsHtml() {
  if (!fresh.length) return '<div class="card"><span class="badge ok">今日新增</span><h2>今日未发现需要行动的重大新变化</h2><p>仍需关注的事项与采集状态见下方；采集失败不会被写成“没有变化”。</p></div>';
  return groups.filter(group => group.items.length).map(group => `<section class="card"><span class="badge">今日新增</span><h2>${group.label}</h2>${group.items.map(item => `<article class="item"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(actions[item.category])}</p><div class="meta"><span>${escapeHtml(item.source)}</span><span>${escapeHtml(item.evidence)}</span>${item.date ? `<span>${item.date}</span>` : ''}</div><a href="${escapeHtml(item.url)}">查看原文</a></article>`).join('')}</section>`).join('');
}

function watchHtml() {
  return `<section class="card"><span class="badge watch">仍需关注</span><h2>当前行动清单</h2>${stillWatching.map(([title, scope, deadline, action, url]) => `<article class="item"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(action)}</p><div class="meta"><span>${escapeHtml(scope)}</span><span>${escapeHtml(deadline)}</span></div><a href="${escapeHtml(url)}">官方来源</a></article>`).join('')}</section>`;
}

function sourceHtml() {
  return `<section class="card"><span class="badge ok">采集透明度</span><h2>来源状态</h2>${collected.map(result => `<div class="source-row"><span>${escapeHtml(result.source.name)}</span><small>${result.ok ? `成功 · ${result.items.length} 条候选` : `失败 · ${escapeHtml(result.error)}`}</small></div>`).join('')}</section>`;
}

async function articleNames() {
  const names = await readdir(articleDir);
  return [...new Set([...names.filter(name => /^\d{4}-\d{2}-\d{2}\.html$/.test(name)), `${today}.html`])].sort().reverse();
}

function page({ archive = [] } = {}) {
  const title = `${displayDate} · 亚马逊跨境风险日报`;
  const archiveHtml = archive.length ? `<section class="card archive"><span class="badge ok">历史日报</span><h2>每日文章</h2>${archive.map(name => { const date = name.slice(0, 10); return `<a href="articles/${name}"><span>${date} 风险雷达</span><span>阅读 →</span></a>`; }).join('')}</section>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="radar-date" content="${today}"><title>${title}</title><meta name="description" content="亚马逊政策、税务关税、出口查验和国际物流的每日中文风险雷达。"><style>${css}</style></head><body><header class="top"><nav class="nav"><a href="${archive.length ? './' : '../'}">亚马逊跨境经营风险雷达</a><span>每天 09:15 更新 · 无需登录</span></nav><div class="hero"><div class="wrap"><p class="kicker">DAILY BRIEFING · ${displayDate}</p><h1>${fresh.length ? `发现 ${fresh.length} 条新线索，先核对适用范围` : '今日没有重大新增，继续处理现有事项'}</h1><p>先给行动结论，再展开亚马逊政策、税务关税、物流查验与来源状态。</p><div class="meta"><span>过去48小时</span><span>未来30天</span><span>官方来源优先</span></div></div></div></header><main class="wrap content"><div>${newItemsHtml()}${watchHtml()}${archiveHtml}</div><aside class="aside">${sourceHtml()}</aside></main><footer>云端自动生成 · 信息跟踪不构成税务、法律或报关意见</footer></body></html>`;
}

const names = await articleNames();
await writeFile(path.join(articleDir, `${today}.html`), page(), 'utf8');
await writeFile(path.join(siteDir, 'index.html'), page({ archive: names.slice(0, 30) }), 'utf8');
await writeFile(statePath, `${JSON.stringify({ seen: [...new Set([...candidates.map(item => item.url), ...(state.seen || [])])].slice(0, 2000), initializedSources: [...new Set([...initializedSources, ...collected.filter(result => result.ok).map(result => result.source.id)])], lastRun: new Date().toISOString(), sourceStatus: collected.map(result => ({ id: result.source.id, ok: result.ok, count: result.items.length, error: result.error || null })) }, null, 2)}\n`, 'utf8');

console.log(`${today}: ${fresh.length} 条新增，${collected.filter(result => result.ok).length}/${collected.length} 个来源成功`);
