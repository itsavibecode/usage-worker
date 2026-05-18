#!/usr/bin/env node
// Renders static HTML previews of the email templates so we can review
// them in a browser without going through the Resend deploy + send cycle.
//
// Run: `node scripts/generate-previews.mjs` from the usage-worker root.
// Output: previews/reminder-email.html, previews/reminder-email.txt,
//         previews/recall-email.html,   previews/recall-email.txt.
//
// Open the .html files in any browser to see the actual rendered emails
// pixel-for-pixel as Resend would deliver them (HTML emails use inline
// styles only — no Google Fonts / no external CSS — so the previews are
// fully self-contained).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReminderEmail, buildRecallEmail } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'previews');
mkdirSync(outDir, { recursive: true });

// ─── reminder email ──────────────────────────────────────────────────
// Sample dataset chosen to cover all three visual states:
//   1. Mid-cycle reminder ("~Nd left" amber pill)
//   2. Just past threshold but still upcoming
//   3. Past-due (red pill, "was due" date suffix)
// Dates are computed from today() so the preview reads like a fresh
// run on whatever day someone opens it.
const today = new Date();
const daysAgo = (d) => {
  const t = new Date(today);
  t.setDate(t.getDate() - d);
  return t.toISOString().slice(0, 10);
};

const sampleReminders = [
  {
    product: {
      productName: 'Old Spice High Endurance Pure Sport Deodorant',
      productType: 'Underarm',
      startDate: daysAgo(88),
    },
    currentDays: 88,
    meanDays: 92,
    ratio: 0.957,
    pastDue: false,
  },
  {
    product: {
      productName: 'Crest 3D White Luminous Mint',
      productType: 'Toothpaste',
      startDate: daysAgo(95),
    },
    currentDays: 95,
    meanDays: 107,
    ratio: 0.888,
    pastDue: false,
  },
  {
    product: {
      productName: 'Reach Mint Waxed Floss',
      productType: 'Floss',
      startDate: daysAgo(142),
    },
    currentDays: 142,
    meanDays: 140,
    ratio: 1.014,
    pastDue: true,
  },
];

const reminderEmail = buildReminderEmail(sampleReminders);
writeFileSync(join(outDir, 'reminder-email.html'), reminderEmail.html);
writeFileSync(join(outDir, 'reminder-email.txt'), reminderEmail.text);
console.log(`✓ reminder-email.html (${reminderEmail.html.length} bytes)`);
console.log(`  subject: ${reminderEmail.subject}`);

// ─── recall email ───────────────────────────────────────────────────
// Three sample recalls covering all severity tiers so the preview shows
// each card variant. Dates use FDA's YYYYMMDD format.
const sampleRecalls = [
  {
    recallNumber: 'D-1234-2024',
    brand: 'Old Spice',
    productDescription: 'Old Spice High Endurance Antiperspirant & Deodorant Stick, Pure Sport scent, 3.0 oz, lots beginning with 47XYZ',
    reason: 'Voluntary recall due to elevated benzene levels detected in routine testing. Long-term exposure to benzene is known to increase cancer risk.',
    date: '20260415',
    classification: 'Class II',
    recallingFirm: 'The Procter & Gamble Company',
    fdaUrl: 'https://www.accessdata.fda.gov/scripts/ires/index.cfm?Product=D-1234-2024',
  },
  {
    recallNumber: 'D-5678-2024',
    brand: 'Crest',
    productDescription: 'Crest 3D White Luminous Mint Toothpaste, 3.7 oz tubes, expiration dates 2027-09 through 2028-03',
    reason: 'Product label does not match formulation — fluoride concentration is outside the labeled range. Voluntary recall, no adverse events reported.',
    date: '20260402',
    classification: 'Class III',
    recallingFirm: 'The Procter & Gamble Company',
    fdaUrl: 'https://www.accessdata.fda.gov/scripts/ires/index.cfm?Product=D-5678-2024',
  },
  {
    recallNumber: 'D-9012-2024',
    brand: 'Sensodyne',
    productDescription: 'Sensodyne Pronamel Gentle Whitening Toothpaste, 4.0 oz, lots manufactured between Jan and Mar 2026',
    reason: 'Potential microbial contamination identified in a single lot during stability testing. Use of contaminated product may pose serious risk to immunocompromised individuals.',
    date: '20260108',
    classification: 'Class I',
    recallingFirm: 'Haleon US Holdings LLC',
    fdaUrl: 'https://www.accessdata.fda.gov/scripts/ires/index.cfm?Product=D-9012-2024',
  },
];

const recallEmail = buildRecallEmail(sampleRecalls);
writeFileSync(join(outDir, 'recall-email.html'), recallEmail.html);
writeFileSync(join(outDir, 'recall-email.txt'), recallEmail.text);
console.log(`✓ recall-email.html (${recallEmail.html.length} bytes)`);
console.log(`  subject: ${recallEmail.subject}`);

console.log(`\nOpen with: file://${outDir}/<filename>.html`);
