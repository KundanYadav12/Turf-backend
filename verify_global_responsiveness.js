const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const CHROME_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ARTIFACT_DIR = 'C:/Users/KUNDAN/.gemini/antigravity-ide/brain/d41541fd-28ff-4bcc-9b3e-4da444c73bab';

const urls = [
  { name: 'HomePage', url: 'http://localhost:3001/' },
  { name: 'SearchPage', url: 'http://localhost:3001/search' },
  { name: 'VenueDetail', url: 'http://localhost:3001/venue/1' },
  { name: 'TournamentsPage', url: 'http://localhost:3001/tournaments' },
  { name: 'TournamentDetail', url: 'http://localhost:3001/tournaments/ed354683-3ee4-4620-adfc-53680b9d3f15' },
  { name: 'MatchDetail', url: 'http://localhost:3001/matches/dcd75e07-772d-4460-8b84-bf35383e8de5' },
  { name: 'TeamsPage', url: 'http://localhost:3001/teams' },
  { name: 'LoginPage', url: 'http://localhost:3001/login' },
  { name: 'RegisterPage', url: 'http://localhost:3001/register' }
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  console.log('=== VERIFYING RESPONSIVENESS ACROSS VIEWPORTS ===\n');
  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();

  let hasAnyFailure = false;

  for (const item of urls) {
    for (const width of [375, 768, 1280]) {
      await page.setViewport({ width, height: 800 });
      await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await sleep(800);

      const info = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        hasHorizScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth
      }));

      const pass = !info.hasHorizScroll;
      if (!pass) hasAnyFailure = true;
      console.log(`[${pass ? 'PASS' : 'FAIL'}] ${item.name} (${width}px): scrollWidth=${info.scrollWidth}, clientWidth=${info.clientWidth}, HorizScroll=${info.hasHorizScroll}`);
    }
  }

  // Test Mobile Navigation Drawer Interaction
  console.log('\n--- Testing Mobile Hamburger Navigation Drawer ---');
  await page.setViewport({ width: 375, height: 800 });
  await page.goto('http://localhost:3001/', { waitUntil: 'domcontentloaded' });
  await sleep(1000);

  const toggleBtn = await page.$('.mobile-menu-toggle-btn');
  if (toggleBtn) {
    await toggleBtn.click();
    await sleep(600);
    const drawerOpen = await page.evaluate(() => {
      const drawer = document.querySelector('.mobile-nav-drawer');
      return !!drawer && window.getComputedStyle(drawer).display !== 'none';
    });
    console.log('✓ Mobile Menu Drawer opened cleanly:', drawerOpen);
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'mobile_navbar_drawer_375px.png') });
    console.log('  Saved screenshot: mobile_navbar_drawer_375px.png');
  } else {
    console.log('✗ Mobile toggle button not found!');
  }

  // Also capture Search Page on 375px
  await page.goto('http://localhost:3001/search', { waitUntil: 'domcontentloaded' });
  await sleep(800);
  await page.screenshot({ path: path.join(ARTIFACT_DIR, 'search_page_375px.png') });

  // Also capture Venue Detail on 375px and 1280px
  await page.goto('http://localhost:3001/venue/1', { waitUntil: 'domcontentloaded' });
  await sleep(800);
  await page.screenshot({ path: path.join(ARTIFACT_DIR, 'venue_detail_375px.png') });
  await page.setViewport({ width: 1280, height: 800 });
  await sleep(600);
  await page.screenshot({ path: path.join(ARTIFACT_DIR, 'venue_detail_1280px.png') });

  await browser.close();
  console.log('\n=== FINAL VERIFICATION RESULT ===');
  if (hasAnyFailure) {
    console.error('❌ Some pages have horizontal scroll issues!');
    process.exit(1);
  } else {
    console.log('✅ ALL PAGES (Mobile 375px, Tablet 768px, Desktop 1280px) ARE 100% RESPONSIVE WITH ZERO OVERFLOW!');
    process.exit(0);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
