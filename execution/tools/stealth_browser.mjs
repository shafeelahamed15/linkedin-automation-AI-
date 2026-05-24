// Tool — single source of truth for the stealth-equipped Chromium.
// Every LinkedIn-touching tool imports `chromium` from THIS file, not from playwright directly.
//
// `puppeteer-extra-plugin-stealth` patches ~17 fingerprint signals that bot-detection
// systems (including LinkedIn's) use to identify automated browsers:
//   - navigator.webdriver           ← the dead giveaway; set to undefined
//   - chrome.runtime                ← real Chrome has this; headless doesn't
//   - navigator.plugins             ← real Chrome populates with PDFViewer + a few more
//   - navigator.languages           ← stripped in headless; faked here
//   - WebGL vendor + renderer       ← real GPU strings instead of "Mozilla / Mozilla"
//   - permissions API               ← Notifications permission was 'denied' in headless
//   - iframe.contentWindow          ← headless has subtle differences
//   - media codecs                  ← real Chrome reports more codecs
//   - ... and others
//
// Naming note: the plugin is called "puppeteer-extra-plugin-stealth" because it
// originated in the Puppeteer ecosystem. `playwright-extra` is a sibling wrapper
// that makes the same plugins work for Playwright.
import { chromium as base } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

base.use(StealthPlugin());

export const chromium = base;
