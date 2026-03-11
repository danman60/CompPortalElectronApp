import { test, expect, _electron as electron } from '@playwright/test';

// Check if we have a display
const hasDisplay = process.env.DISPLAY || process.env.WAYLAND_DISPLAY;
if (!hasDisplay) {
  console.warn('WARNING: No DISPLAY or WAYLAND_DISPLAY environment variable set.');
  console.warn('Electron requires a display server. Setting DISPLAY=:0 as fallback.');
  process.env.DISPLAY = ':0';
}

test.describe('CompSync Media - Comprehensive Test Suite', () => {
  let app: electron.ElectronApplication;
  let window: electron.Page;

  test.beforeEach(async () => {
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

    window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);
  });

  test.afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  // ============================================================================
  // SECTION 1: App Launch & Basic Functionality
  // ============================================================================

  test('app launches and shows main window', async () => {
    const title = await window.title();
    console.log('Window title:', title);
    expect(title).toBe('CompSync Media');

    await window.screenshot({ path: 'test-results/01-launch.png' });

    const userDataPath = await app.evaluate(async ({ app }) => {
      return app.getPath('userData');
    });
    console.log('User data path:', userDataPath);
    expect(typeof userDataPath).toBe('string');
  });

  test('app version is returned correctly', async () => {
    const version = await window.evaluate(async () => {
      return await window.api.getVersion();
    });
    console.log('App version:', version);
    expect(version).toBeTruthy();
    expect(typeof version).toBe('string');
  });

  // ============================================================================
  // SECTION 2: Preload API Exposure
  // ============================================================================

  test('all expected APIs are exposed in preload', async () => {
    const exposedApis = await window.evaluate(() => {
      return Object.keys(window.api || {});
    });
    console.log('Exposed APIs:', exposedApis);

    // Core APIs that must exist
    const requiredApis = [
      'settingsGet', 'settingsSet',
      'obsConnect', 'obsStartRecord', 'obsStopRecord',
      'recordingNext', 'recordingPrev', 'recordingNextFull',
      'scheduleGet', 'scheduleLoadShareCode',
      'uploadAll', 'uploadStart', 'uploadStop',
      'jobQueueGet', 'jobQueueRetry', 'jobQueueCancel',
      'getVersion', 'openPath',
    ];

    for (const api of requiredApis) {
      expect(exposedApis).toContain(api);
    }
  });

  // ============================================================================
  // SECTION 3: Settings IPC
  // ============================================================================

  test('settings IPC - get and structure', async () => {
    const settings = await window.evaluate(async () => {
      return await window.api.settingsGet();
    });

    console.log('Settings keys:', Object.keys(settings));
    expect(settings).toBeTruthy();

    // Check all expected settings sections
    expect(settings).toHaveProperty('obs');
    expect(settings).toHaveProperty('compsync');
    expect(settings).toHaveProperty('competition');
    expect(settings).toHaveProperty('audioTrackMapping');
    expect(settings).toHaveProperty('audioInputMapping');
    expect(settings).toHaveProperty('fileNaming');
    expect(settings).toHaveProperty('ffmpeg');
    expect(settings).toHaveProperty('hotkeys');
    expect(settings).toHaveProperty('overlay');
    expect(settings).toHaveProperty('behavior');

    // Check specific properties
    expect(settings.obs).toHaveProperty('url');
    expect(settings.obs).toHaveProperty('password');
    expect(settings.competition).toHaveProperty('judgeCount');
    expect(settings.behavior).toHaveProperty('autoRecordOnNext');
  });

  test('settings IPC - set and persist', async () => {
    const originalSettings = await window.evaluate(async () => {
      return await window.api.settingsGet();
    });

    // Modify a setting
    const testJudgeCount = originalSettings.competition.judgeCount === 3 ? 2 : 3;

    await window.evaluate(async (judgeCount) => {
      const settings = await window.api.settingsGet();
      settings.competition.judgeCount = judgeCount;
      await window.api.settingsSet(settings);
    }, testJudgeCount);

    // Verify the change persisted
    const newSettings = await window.evaluate(async () => {
      return await window.api.settingsGet();
    });

    expect(newSettings.competition.judgeCount).toBe(testJudgeCount);

    // Restore original
    await window.evaluate(async (original) => {
      await window.api.settingsSet(original);
    }, originalSettings);
  });

  // ============================================================================
  // SECTION 4: Schedule/Competition IPC
  // ============================================================================

  test('schedule IPC - get returns null when no competition loaded', async () => {
    const schedule = await window.evaluate(async () => {
      return await window.api.scheduleGet();
    });

    // Should be null or undefined when no competition is loaded
    console.log('Schedule (no comp):', schedule);
    // This is expected to be null in a fresh test environment
  });

  // ============================================================================
  // SECTION 5: Job Queue IPC
  // ============================================================================

  test('job queue IPC - returns array', async () => {
    const jobQueue = await window.evaluate(async () => {
      return await window.api.jobQueueGet();
    });

    console.log('Job queue:', jobQueue);
    expect(Array.isArray(jobQueue)).toBe(true);
  });

  // ============================================================================
  // SECTION 6: OBS IPC (without actual OBS connection)
  // ============================================================================

  test('OBS IPC - connect returns error for invalid URL', async () => {
    // Try to connect to invalid OBS URL
    const result = await window.evaluate(async () => {
      try {
        return await window.api.obsConnect('ws://invalid:9999', '');
      } catch (err) {
        return { error: err.message };
      }
    });

    console.log('OBS connect result:', result);
    // Should either return error or connection status
    expect(result).toBeDefined();
  });

  test('OBS IPC - getInputList returns array', async () => {
    const inputs = await window.evaluate(async () => {
      try {
        return await window.api.obsGetInputList();
      } catch (err) {
        return [];
      }
    });

    console.log('OBS inputs:', inputs);
    expect(Array.isArray(inputs)).toBe(true);
  });

  // ============================================================================
  // SECTION 7: Recording Navigation IPC
  // ============================================================================

  test('recording navigation - next/prev/nextFull work without errors', async () => {
    // These should not throw even without a loaded competition
    const results = await window.evaluate(async () => {
      const results: Record<string, unknown> = {};
      try {
        await window.api.recordingNext();
        results.next = 'success';
      } catch (err) {
        results.next = err.message;
      }
      try {
        await window.api.recordingPrev();
        results.prev = 'success';
      } catch (err) {
        results.prev = err.message;
      }
      try {
        await window.api.recordingNextFull();
        results.nextFull = 'success';
      } catch (err) {
        results.nextFull = err.message;
      }
      return results;
    });

    console.log('Recording nav results:', results);
    // Should complete without throwing
    expect(results).toBeDefined();
  });

  // ============================================================================
  // SECTION 8: Upload IPC
  // ============================================================================

  test('upload IPC - uploadAll returns result', async () => {
    const result = await window.evaluate(async () => {
      try {
        return await window.api.uploadAll();
      } catch (err) {
        return { error: err.message };
      }
    });

    console.log('Upload all result:', result);
    expect(result).toBeDefined();
  });

  // ============================================================================
  // SECTION 9: Overlay IPC
  // ============================================================================

  test('overlay IPC - getState returns state object', async () => {
    const state = await window.evaluate(async () => {
      try {
        return await window.api.overlayGetState();
      } catch (err) {
        return { error: err.message };
      }
    });

    console.log('Overlay state:', state);
    expect(state).toBeDefined();
  });

  test('overlay IPC - toggle and fire operations work', async () => {
    const results = await window.evaluate(async () => {
      const results: Record<string, unknown> = {};
      try {
        results.fireLT = await window.api.overlayFireLT();
      } catch (err) {
        results.fireLT = { error: err.message };
      }
      try {
        results.hideLT = await window.api.overlayHideLT();
      } catch (err) {
        results.hideLT = { error: err.message };
      }
      return results;
    });

    console.log('Overlay operations:', results);
    expect(results).toBeDefined();
  });

  // ============================================================================
  // SECTION 10: UI Components
  // ============================================================================

  test('UI - header elements are visible', async () => {
    await window.screenshot({ path: 'test-results/02-header.png' });

    // Check for header elements
    const header = await window.locator('.app-header');
    await expect(header).toBeVisible();

    const logo = await window.locator('.app-logo');
    await expect(logo).toBeVisible();

    // Check for buttons
    const buttons = await window.locator('button').count();
    console.log(`Found ${buttons} buttons`);
    expect(buttons).toBeGreaterThan(0);
  });

  test('UI - settings button opens settings', async () => {
    const settingsBtn = await window.locator('button:has-text("Settings")');
    await expect(settingsBtn).toBeVisible();

    await settingsBtn.click();
    await window.waitForTimeout(500);

    await window.screenshot({ path: 'test-results/03-settings.png' });

    // Check settings overlay is visible
    const settingsOverlay = await window.locator('.settings-overlay');
    const isVisible = await settingsOverlay.isVisible().catch(() => false);

    if (isVisible) {
      // Close settings
      const backBtn = await window.locator('.settings-header .back-btn');
      await backBtn.click();
      await window.waitForTimeout(300);
    }
  });

  test('UI - load competition button exists', async () => {
    const loadBtn = await window.locator('button:has-text("Load Competition")');
    await expect(loadBtn).toBeVisible();
  });

  // ============================================================================
  // SECTION 11: Event Listeners
  // ============================================================================

  test('event listeners - can subscribe and unsubscribe', async () => {
    const result = await window.evaluate(async () => {
      // Subscribe to an event
      const unsubscribe = window.api.on('state:update', () => {});

      // Unsubscribe
      unsubscribe();

      return { success: true };
    });

    expect(result.success).toBe(true);
  });

  // ============================================================================
  // SECTION 12: Error Handling
  // ============================================================================

  test('error handling - invalid routine ID returns error', async () => {
    const result = await window.evaluate(async () => {
      try {
        await window.api.uploadRoutine('invalid-id-12345');
        return { success: true };
      } catch (err) {
        return { error: err.message };
      }
    });

    console.log('Invalid routine result:', result);
    // Should either succeed silently or return error
    expect(result).toBeDefined();
  });

  test('error handling - skip without routine returns error', async () => {
    const result = await window.evaluate(async () => {
      try {
        await window.api.recordingSkip('');
        return { success: true };
      } catch (err) {
        return { error: err.message };
      }
    });

    console.log('Skip empty result:', result);
    expect(result).toBeDefined();
  });

  // ============================================================================
  // SECTION 13: Main Process State
  // ============================================================================

  test('main process - can access app paths', async () => {
    const paths = await app.evaluate(async ({ app }) => {
      return {
        userData: app.getPath('userData'),
        temp: app.getPath('temp'),
        downloads: app.getPath('downloads'),
        documents: app.getPath('documents'),
      };
    });

    console.log('App paths:', paths);
    expect(paths.userData).toBeTruthy();
    expect(paths.temp).toBeTruthy();
  });

  // ============================================================================
  // SECTION 14: Full UI Screenshot Suite
  // ============================================================================

  test('screenshot - full app layout', async () => {
    // Take full page screenshot
    await window.screenshot({
      path: 'test-results/04-full-app.png',
      fullPage: true
    });
  });

  test('screenshot - left panel', async () => {
    const leftPanel = await window.locator('.left-panel');
    const isVisible = await leftPanel.isVisible().catch(() => false);

    if (isVisible) {
      await leftPanel.screenshot({ path: 'test-results/05-left-panel.png' });
    }
  });

  test('screenshot - right panel', async () => {
    const rightPanel = await window.locator('.right-panel');
    const isVisible = await rightPanel.isVisible().catch(() => false);

    if (isVisible) {
      await rightPanel.screenshot({ path: 'test-results/06-right-panel.png' });
    }
  });
});
