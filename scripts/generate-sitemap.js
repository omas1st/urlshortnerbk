// generate-sitemap.js
// Usage:
//   node scripts/generate-sitemap.js                 -> auto-detects client/public or public (creates if missing)
//   node scripts/generate-sitemap.js client/public  -> write to client/public
//   SITEMAP_DEST=client/public node scripts/generate-sitemap.js

const fs = require('fs');
const path = require('path');

const argDest = process.argv[2] || process.env.SITEMAP_DEST || '';
const projectRoot = process.cwd();

// Candidate destinations (in order of preference)
const candidates = [
  argDest,
  path.join(projectRoot, 'client', 'public'),
  path.join(projectRoot, 'frontend', 'public'),
  path.join(projectRoot, 'public')
].filter(Boolean);

// Find an existing candidate or fall back to the first one (will be created)
let chosen = candidates.find(p => fs.existsSync(path.resolve(p)));
if (!chosen) {
  chosen = argDest || path.join(projectRoot, 'public');
}
const destDir = path.resolve(chosen);

// Ensure directory exists (recursive so it creates parent folders if needed)
fs.mkdirSync(destDir, { recursive: true });

// Public routes to include
const routes = ['/', '/about', '/faq', '/privacy', '/terms', '/login', '/register'];

// KEYWORDS (converted to tag pages /tags/<slug>)
// These come from your list and will create tag landing URLs like /tags/url-redirection-service
const tags = [
  "URL redirection service",
  "301 URL shortener",
  "Link cloaking",
  "UTM parameters shortener",
  "Self-hosted URL shortener",
  "Open source URL shortener",
  "API URL shortening",
  "Bitly alternative",
  "TinyURL alternative",
  "Free Bitly alternative",
  "Rebrandly vs Bitly",
  "Best free URL shortener",
  "URL shortener no ads",
  "Privacy-focused URL shortener",
  "Instagram link in bio tool",
  "TikTok link shortener",
  "YouTube description link shortener",
  "Email marketing link shortener",
  "SMS link shortener",
  "QR code with link tracking",
  "Podcast link shortener",
  "Affiliate link shortener",
  "Digital business card links",
  "Event link shortener",
  "Best URL shortener",
  "Top link shorteners 2026",
  "URL shortener with custom domain",
  "Free branded link shortener",
  "URL shortener for business",
  "Shorten URLs for Instagram",
  "Shorten links for TikTok",
  "Short URLs for Twitter/X",
  "URL shortener for YouTube",
  "Shopify link shortener",
  "Bitly",
  "TinyURL",
  "Short.io",
  "Rebrandly",
  "BL.INK",
  "Ow.ly (Hootsuite)",
  "Cutt.ly",
  "is.gd",
  "T2M (Tiny.cc)",
  "Polr",
  "Yourls (self-hosted)",
  "ClickMeter",
  "Lites.press",
  "Sniply (now part of Rewind)",
  "Kutt.it",
  "Shorby",
  "PicSee (for visual links)",
  "Buffer for links",
  "Password-protected short links",
  "Expiring short links",
  "UTM builder for URLs",
  "Bulk URL shortening",
  "API for URL shortening",
  "Link retargeting",
  "Geo-targeted links",
  "A/B testing for links",
  "Mobile deep linking",
  "Social media link shortener",
  "Free custom URL shortener",
  "Branded URL shortener",
  "Shorten long URL",
  "URL management tool",
  "Click tracking",
  "URL analytics",
  "Link management",
  "Short URL with analytics",
  "Create short link",
  "QR code generator from URL",
  "Bio link tool",
  "Shorten URL",
  "URL shortener free",
  "Short link",
  "Link shortener",
  "Free link shortener",
  "URL shortening service",
  "Custom URL shortener",
  "Shorten links",
  "URL shrinker",
  "Link compressor"
];

// Helper to slugify tag into /tags/<slug>
const slugify = (s) =>
  s
    .toString()
    .normalize('NFKD')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/\-\-+/g, '-');

const today = new Date().toISOString().split('T')[0];

const urlEntries = routes.map(r => {
  const loc = `https://omsurl.com${r}`.replace(/([^:]\/)\/+/g, '$1');
  return `  <url>
    <loc>${loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
  </url>`;
});

const tagEntries = tags.map(t => {
  const slug = slugify(t);
  const loc = `https://omsurl.com/tags/${slug}`;
  return `  <url>
    <loc>${loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
  </url>`;
});

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[...urlEntries, ...tagEntries].join('\n')}
</urlset>`;

// Write file
const outPath = path.join(destDir, 'sitemap.xml');
fs.writeFileSync(outPath, xml, 'utf8');

console.log(`sitemap.xml generated at: ${outPath}`);
console.log('Routes included:', routes.join(', '));
if (tags.length) console.log('Tag pages included:', tags.length, 'tags');
