import { test, expect, _electron as electron } from '@playwright/test';

// Check if we have a display
const hasDisplay = process.env.DISPLAY || process.env.WAYLAND_DISPLAY;
if (!hasDisplay) {
  console.warn('WARNING: No DISPLAY or WAYLAND_DISPLAY environment variable set.');
  console.warn('Electron requires a display server. Setting DISPLAY=:0 as fallback.');
  process.env.DISPLAY = ':0';
}

test.describe('Electron App', () => {
  let app: electron.ElectronApplication;
  let window: electron.Page;

  test.beforeEach(async () => {
    // Launch Electron app with built entry point
    app = await electron.launch({
      args: [
        './out/main/index.js',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-software-rasterizer',
        '--disable-gpu-sandbox',
        '--disable-features=VizDisplayCompositor',
      ],
      env: {
        ...process.env,
        ELECTRON_DISABLE_GPU: '1',
        DISPLAY: process.env.DISPLAY || ':0',
      },
      timeout: 30000,
    });

    // Get the first window
    window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000); // Allow UI to settle
  });

  test.afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  test('app launches and shows main window', async () => {
    // Screenshot the initial state
    try {
      await window.screenshot({ path: 'test-results/launch.png' });
    } catch (err) {
      console.warn('Screenshot failed:', err);
    }

    // Verify window title
    const title = await window.title();
    console.log('Window title:', title);
    expect(title).toBeTruthy();

    // Test basic IPC - get user data path
    const userDataPath = await app.evaluate(async ({ app }) => {
      return app.getPath('userData');
    });
    console.log('User data path:', userDataPath);
    expect(typeof userDataPath).toBe('string');
    expect(userDataPath.length).toBeGreaterThan(0);
  });

  test('preload API is exposed', async () => {
    // Check what's exposed in the preload
    const exposedApis = await window.evaluate(() => {
      // @ts-ignore
      return Object.keys(window.api || {});
    });
    console.log('Exposed APIs count:', exposedApis.length);
    expect(exposedApis.length).toBeGreaterThan(0);
    expect(exposedApis).toContain('settingsGet');
  });

  test('settings IPC works', async () => {
    // Get settings via IPC
    const settings = await window.evaluate(async () => {
      // @ts-ignore
      if (window.api && window.api.settingsGet) {
        // @ts-ignore
        return await window.api.settingsGet();
      }
      return null;
    });

    console.log('Settings received, keys:', Object.keys(settings));
    expect(settings).toBeTruthy();
    expect(settings).toHaveProperty('behavior');
    expect(settings).toHaveProperty('fileNaming');
    expect(settings).toHaveProperty('obs');
  });

  test('app version IPC', async () => {
    const version = await window.evaluate(async () => {
      // @ts-ignore
      if (window.api && window.api.getVersion) {
        // @ts-ignore
        return await window.api.getVersion();
      }
      return null;
    });

    console.log('App version:', version);
    expect(version).toBeTruthy();
    expect(typeof version).toBe('string');
    expect(version).toMatch(/^\d+\.\d+\.\d+$/); // Should be semantic version
  });

  test('job queue IPC returns array', async () => {
    const jobQueue = await window.evaluate(async () => {
      // @ts-ignore
      if (window.api && window.api.jobQueueGet) {
        // @ts-ignore
        return await window.api.jobQueueGet();
      }
      return null;
    });

    console.log('Job queue type:', typeof jobQueue, 'length:', Array.isArray(jobQueue) ? jobQueue.length : 'N/A');
    expect(Array.isArray(jobQueue)).toBe(true);
  });

  test('UI contains main elements', async () => {
    // Check for some UI elements by text or class
    const body = await window.locator('body');
    await expect(body).toBeVisible();

    // Look for any buttons or headings
    const buttons = await window.locator('button').count();
    const headings = await window.locator('h1, h2, h3, h4, h5, h6').count();
    console.log(`Found ${buttons} buttons, ${headings} headings`);

    // Take a screenshot of the UI
    try {
      await window.screenshot({ path: 'test-results/ui-elements.png' });
    } catch (err) {
      console.warn('UI screenshot failed:', err);
    }
  });
});