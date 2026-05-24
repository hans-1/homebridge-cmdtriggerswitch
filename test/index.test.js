'use strict';

// --- Fake timers (must be before any require) -------------------------------
jest.useFakeTimers();

// --- Mock node-persist ------------------------------------------------------
const mockStorage = {
  init: jest.fn(),
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
};
jest.mock('node-persist', () => mockStorage);

// --- Mock child_process -----------------------------------------------------
const mockExec = jest.fn();
jest.mock('child_process', () => ({ exec: mockExec }));

// --- Homebridge mock ---------------------------------------------------------
//
// Characteristic must be a real constructor because the plugin does:
//   Characteristic.Delay = function() { Characteristic.call(this, ...); }
//   inherits(Characteristic.Delay, Characteristic)

function MockCharacteristic(label, uuid, props) {
  this.label = label;
  this.uuid = uuid;
  this.props = props;
  this.value = null;
}
MockCharacteristic.prototype.getDefaultValue = function () { return null; };
MockCharacteristic.On          = 'On';
MockCharacteristic.Name        = 'Name';
MockCharacteristic.Manufacturer = 'Manufacturer';
MockCharacteristic.Model       = 'Model';
MockCharacteristic.Formats     = { UINT64: 'uint64' };
MockCharacteristic.Perms       = { READ: 'read', WRITE: 'write', NOTIFY: 'notify' };

function makeMockSwitchService() {
  // Each characteristic key gets its own mock instance so that onGet/onSet
  // registrations for Characteristic.On and Characteristic.Delay are independent
  // and do not overwrite each other.
  const chars = {};
  function getOrCreate(key) {
    if (!chars[key]) {
      chars[key] = { value: null, onGet: jest.fn().mockReturnThis(), onSet: jest.fn().mockReturnThis() };
    }
    return chars[key];
  }
  return {
    _chars: chars,
    getCharacteristic: jest.fn().mockImplementation((key) => getOrCreate(key)),
    updateCharacteristic: jest.fn(),
    setCharacteristic: jest.fn().mockReturnThis(),
    addCharacteristic: jest.fn().mockReturnThis(),
  };
}

function makeMockAccessoryInfoService() {
  return { setCharacteristic: jest.fn().mockReturnThis() };
}

const MockService = {
  Switch: jest.fn(),
  AccessoryInformation: jest.fn(),
};

const mockLog = Object.assign(jest.fn(), {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
});

const mockHomebridge = {
  hap: { Service: MockService, Characteristic: MockCharacteristic },
  registerAccessory: jest.fn(),
  user: { persistPath: jest.fn().mockReturnValue('/tmp/test-persist') },
};

// --- Load plugin & capture CmdTriggerSwitch constructor ---------------------
let CmdTriggerSwitch;
mockHomebridge.registerAccessory.mockImplementation((_plugin, _type, Constructor) => {
  CmdTriggerSwitch = Constructor;
});
require('../index')(mockHomebridge);

// --- Helper ------------------------------------------------------------------
//
// makeSwitch returns { sw, service, accessoryInfo } so each test can assert
// against its own isolated mocks, even when multiple switches are created.

function makeSwitch(configOverrides = {}) {
  const service = makeMockSwitchService();
  const accessoryInfo = makeMockAccessoryInfoService();
  MockService.Switch.mockReturnValue(service);
  MockService.AccessoryInformation.mockReturnValue(accessoryInfo);

  const config = {
    name: 'TestSwitch',
    onCmd: 'echo ON',
    offCmd: 'echo OFF',
    ...configOverrides,
  };

  const sw = new CmdTriggerSwitch(mockLog, config);
  return { sw, service, accessoryInfo };
}

// --- Reset state between tests -----------------------------------------------
beforeEach(() => {
  jest.resetAllMocks();
  // delete MockCharacteristic.Delay between tests: createSwitchService mutates
  // the global MockCharacteristic object, so the Delay constructor must be
  // cleared to prevent pollution across tests.
  delete MockCharacteristic.Delay;

  // Restore default implementations cleared by resetAllMocks
  mockStorage.init.mockResolvedValue(undefined);
  mockStorage.getItem.mockResolvedValue(undefined);
  mockStorage.setItem.mockResolvedValue(undefined);
  mockStorage.removeItem.mockResolvedValue(undefined);
  mockHomebridge.user.persistPath.mockReturnValue('/tmp/test-persist');
});

afterEach(() => {
  jest.clearAllTimers();
});

// ============================================================================
// 1. Configuration
// ============================================================================

describe('Configuration', () => {
  test('basic config initialises with correct defaults', async () => {
    // Guards against silent regressions in defaults that Homebridge and existing
    // users depend on.
    const { sw } = makeSwitch();
    await sw.storageReady;
    expect(sw.stateful).toBe(false);
    expect(sw.delay).toBe(1000);
    expect(sw.delayUnit).toBe('ms');
    expect(sw.delayFactor).toBe(1);
    expect(sw.interactiveDelay).toBe(false);
  });

  test('stateful flag is set from config', async () => {
    // stateful: true routes all writes through setItem and skips the auto-off
    // timer path entirely.
    const { sw } = makeSwitch({ stateful: true });
    await sw.storageReady;
    expect(sw.stateful).toBe(true);
  });

  test('missing delay defaults to 1000', async () => {
    // 1000ms is the documented default; changing it would silently break
    // existing configs that omit the delay field.
    const { sw } = makeSwitch({ delay: undefined });
    await sw.storageReady;
    expect(sw.delay).toBe(1000);
  });

  test('delay is parsed as integer from string', async () => {
    // Homebridge config values arrive as JSON strings; parseInt() is essential
    // so that delay * delayFactor produces a valid millisecond value.
    const { sw } = makeSwitch({ delay: '2500' });
    await sw.storageReady;
    expect(sw.delay).toBe(2500);
  });

  test('delayUnit "ms" sets delayFactor to 1', async () => {
    // Explicit "ms" must behave identically to the omitted default; covers
    // configs that set it explicitly.
    const { sw } = makeSwitch({ delayUnit: 'ms' });
    await sw.storageReady;
    expect(sw.delayFactor).toBe(1);
  });

  test('delayUnit "s" sets delayFactor to 1000', async () => {
    // Verifies the unit-conversion multiplier used when scheduling the
    // auto-off timeout.
    const { sw } = makeSwitch({ delayUnit: 's' });
    await sw.storageReady;
    expect(sw.delayFactor).toBe(1000);
  });

  test('delayUnit "min" sets delayFactor to 60000', async () => {
    // Same as above for minutes; 60*1000 is easy to mis-type.
    const { sw } = makeSwitch({ delayUnit: 'min' });
    await sw.storageReady;
    expect(sw.delayFactor).toBe(60000);
  });

  test('unknown delayUnit throws', () => {
    // Any unrecognised unit must fail loudly at startup rather than silently
    // scheduling a timeout with the wrong multiplier.
    expect(() => makeSwitch({ delayUnit: 'hr' }))
      .toThrow('Unknown delayUnit');
  });

  test('missing delayUnit defaults to "ms"', async () => {
    // Omitting delayUnit is the common case in existing configs; must not break.
    const { sw } = makeSwitch({ delayUnit: undefined });
    await sw.storageReady;
    expect(sw.delayUnit).toBe('ms');
    expect(sw.delayFactor).toBe(1);
  });

  test('valid interactiveDelay settings are stored', async () => {
    // All interactiveDelay fields must be stored on the instance so that
    // switchSetDelay and _restoreState can reference them at runtime.
    const { sw } = makeSwitch({
      interactiveDelaySettings: {
        interactiveDelay: true,
        delayMin: 100,
        delayMax: 1000,
        delayStep: 100,
      },
    });
    await sw.storageReady;
    expect(sw.interactiveDelay).toBe(true);
    expect(sw.delayMin).toBe(100);
    expect(sw.delayMax).toBe(1000);
    expect(sw.delayStep).toBe(100);
  });

  test('interactiveDelayLabel defaults to "Delay"', async () => {
    // The label is displayed in the HomeKit slider UI; the default must match
    // the documented value.
    const { sw } = makeSwitch({
      interactiveDelaySettings: {
        interactiveDelay: true,
        delayMin: 100,
        delayMax: 1000,
        delayStep: 100,
      },
    });
    await sw.storageReady;
    expect(sw.interactiveDelayLabel).toBe('Delay');
  });

  test('custom interactiveDelayLabel is used', async () => {
    // Ensures a user-supplied label is not silently ignored.
    const { sw } = makeSwitch({
      interactiveDelaySettings: {
        interactiveDelay: true,
        interactiveDelayLabel: 'Custom Label',
        delayMin: 100,
        delayMax: 1000,
        delayStep: 100,
      },
    });
    await sw.storageReady;
    expect(sw.interactiveDelayLabel).toBe('Custom Label');
  });

  test('delayMax equal to delayMin throws', () => {
    // delayMin === delayMax produces a zero-width HomeKit slider, which must
    // be rejected at startup.
    expect(() =>
      makeSwitch({
        interactiveDelaySettings: {
          interactiveDelay: true,
          delayMin: 500,
          delayMax: 500,
          delayStep: 100,
        },
      })
    ).toThrow('delayMin must be smaller than delayMax');
  });

  test('delayMax less than delayMin throws', () => {
    // Inverted bounds produce a negative-range slider; the same <= guard
    // catches both the equal-to and less-than cases.
    expect(() =>
      makeSwitch({
        interactiveDelaySettings: {
          interactiveDelay: true,
          delayMin: 800,
          delayMax: 500,
          delayStep: 100,
        },
      })
    ).toThrow('delayMin must be smaller than delayMax');
  });

  test('delayStep equal to (delayMax - delayMin) throws', () => {
    // A step equal to the full range leaves no valid intermediate value and
    // must be rejected.
    expect(() =>
      makeSwitch({
        interactiveDelaySettings: {
          interactiveDelay: true,
          delayMin: 100,
          delayMax: 600,
          delayStep: 500,
        },
      })
    ).toThrow('delayStep must be smaller than');
  });

  test('delayStep greater than (delayMax - delayMin) throws', () => {
    // Step wider than range is equally invalid; guards the same >= condition.
    expect(() =>
      makeSwitch({
        interactiveDelaySettings: {
          interactiveDelay: true,
          delayMin: 100,
          delayMax: 600,
          delayStep: 600,
        },
      })
    ).toThrow('delayStep must be smaller than');
  });
});

// ============================================================================
// 2. Service Creation
// ============================================================================

describe('Service Creation', () => {
  test('getServices returns [accessoryInformationService, switchService] in that order', async () => {
    // Homebridge requires accessoryInformationService to be first in the array.
    const { sw } = makeSwitch();
    await sw.storageReady;
    const services = sw.getServices();
    expect(services).toHaveLength(2);
    expect(services[0]).toBe(sw.accessoryInformationService);
    expect(services[1]).toBe(sw.switchService);
  });

  test('Delay characteristic is added for non-stateful switch with interactiveDelay', async () => {
    // The custom Delay characteristic only makes sense for non-stateful
    // (auto-off) switches where the user can adjust the timer duration.
    const { sw, service } = makeSwitch({
      interactiveDelaySettings: {
        interactiveDelay: true,
        delayMin: 100,
        delayMax: 1000,
        delayStep: 100,
      },
    });
    await sw.storageReady;
    expect(service.addCharacteristic).toHaveBeenCalled();
  });

  test('Delay characteristic is NOT added for stateful switch even if interactiveDelay is set', async () => {
    // Stateful switches have no auto-off timer, so the Delay slider must be
    // suppressed regardless of the interactiveDelay setting.
    const { sw, service } = makeSwitch({
      stateful: true,
      interactiveDelaySettings: {
        interactiveDelay: true,
        delayMin: 100,
        delayMax: 1000,
        delayStep: 100,
      },
    });
    await sw.storageReady;
    expect(service.addCharacteristic).not.toHaveBeenCalled();
  });

  test('Delay characteristic is NOT added when interactiveDelay is false', async () => {
    // interactiveDelay: false means use only the static config delay; no
    // slider should appear in HomeKit.
    const { sw, service } = makeSwitch({
      interactiveDelaySettings: {
        interactiveDelay: false,
        delayMin: 100,
        delayMax: 1000,
        delayStep: 100,
      },
    });
    await sw.storageReady;
    expect(service.addCharacteristic).not.toHaveBeenCalled();
  });

  test('Switch service is registered with correct name', async () => {
    // The service name drives the HomeKit display name and the storage key
    // prefix used for state persistence.
    const { sw } = makeSwitch({ name: 'MyGarageSwitch' });
    await sw.storageReady;
    expect(MockService.Switch).toHaveBeenCalledWith('MyGarageSwitch');
  });

  test('onGet handler is registered for On characteristic', () => {
    // Homebridge v2 requires onGet for every readable characteristic;
    // absence silently falls back to cached .value but logs a warning.
    const { service } = makeSwitch();
    expect(service._chars[MockCharacteristic.On].onGet).toHaveBeenCalledTimes(1);
  });

  test('onGet for On returns the current characteristic value', () => {
    // The getter must reflect live .value so HomeKit reads are always
    // fresh rather than returning a stale snapshot.
    const { service } = makeSwitch();
    const handler = service._chars[MockCharacteristic.On].onGet.mock.calls[0][0];
    service._chars[MockCharacteristic.On].value = true;
    expect(handler()).toBe(true);
    service._chars[MockCharacteristic.On].value = false;
    expect(handler()).toBe(false);
  });

  test('onGet and onSet handlers are registered for Delay characteristic', async () => {
    // Both handlers must be present: onGet so HomeKit can read the slider
    // position, onSet so user adjustments are persisted.
    const { sw, service } = makeSwitch({
      interactiveDelaySettings: {
        interactiveDelay: true,
        delayMin: 100,
        delayMax: 1000,
        delayStep: 100,
      },
    });
    await sw.storageReady;
    expect(service._chars[MockCharacteristic.Delay].onGet).toHaveBeenCalledTimes(1);
    expect(service._chars[MockCharacteristic.Delay].onSet).toHaveBeenCalledTimes(1);
  });

  test('onGet for Delay returns the current characteristic value', async () => {
    // Same rationale as On: the getter must reflect the current slider value.
    const { sw, service } = makeSwitch({
      interactiveDelaySettings: {
        interactiveDelay: true,
        delayMin: 100,
        delayMax: 1000,
        delayStep: 100,
      },
    });
    await sw.storageReady;
    const delayChar = service._chars[MockCharacteristic.Delay];
    const handler = delayChar.onGet.mock.calls[0][0];
    delayChar.value = 500;
    expect(handler()).toBe(500);
  });

});

// ============================================================================
// 3. switchSetOn - Stateful Switch
// ============================================================================

describe('switchSetOn - stateful switch', () => {
  test('turning ON saves true to storage and executes onCmd', async () => {
    // Core stateful path: every ON must both persist state and run the
    // user's configured command.
    const { sw } = makeSwitch({ stateful: true });
    await sw.storageReady;
    await sw.switchSetOn(true);
    expect(mockStorage.setItem).toHaveBeenCalledWith('TestSwitch', true);
    expect(mockExec).toHaveBeenCalledWith('echo ON');
  });

  test('turning OFF saves false to storage and executes offCmd', async () => {
    // Same for OFF; both persistence and command must fire.
    const { sw } = makeSwitch({ stateful: true });
    await sw.storageReady;
    await sw.switchSetOn(false);
    expect(mockStorage.setItem).toHaveBeenCalledWith('TestSwitch', false);
    expect(mockExec).toHaveBeenCalledWith('echo OFF');
  });

  test('turning ON without onCmd saves state but does not exec', async () => {
    // onCmd is optional; omitting it must not throw or suppress the storage
    // write.
    const { sw } = makeSwitch({ stateful: true, onCmd: undefined });
    await sw.storageReady;
    await sw.switchSetOn(true);
    expect(mockStorage.setItem).toHaveBeenCalledWith('TestSwitch', true);
    expect(mockExec).not.toHaveBeenCalled();
  });

  test('turning OFF without offCmd saves state but does not exec', async () => {
    // Same for offCmd.
    const { sw } = makeSwitch({ stateful: true, offCmd: undefined });
    await sw.storageReady;
    await sw.switchSetOn(false);
    expect(mockStorage.setItem).toHaveBeenCalledWith('TestSwitch', false);
    expect(mockExec).not.toHaveBeenCalled();
  });

  test('multiple toggles all execute commands', async () => {
    // Guards against any internal counter or flag that might suppress commands
    // after the first toggle.
    const { sw } = makeSwitch({ stateful: true });
    await sw.storageReady;
    await sw.switchSetOn(true);
    await sw.switchSetOn(false);
    await sw.switchSetOn(true);
    expect(mockExec).toHaveBeenCalledTimes(3);
    expect(mockExec).toHaveBeenNthCalledWith(1, 'echo ON');
    expect(mockExec).toHaveBeenNthCalledWith(2, 'echo OFF');
    expect(mockExec).toHaveBeenNthCalledWith(3, 'echo ON');
  });
});

// ============================================================================
// 4. switchSetOn - Temporary (Non-Stateful) Switch
// ============================================================================

describe('switchSetOn - temporary switch', () => {
  test('turning ON saves startTime and executes onCmd', async () => {
    // startTime is written to storage so _restoreState can compute
    // remainingDelay after a Homebridge restart.
    const { sw } = makeSwitch({ delay: 5000, delayUnit: 'ms' });
    await sw.storageReady;
    await sw.switchSetOn(true);
    expect(mockStorage.setItem).toHaveBeenCalledWith('TestSwitch - startTime', expect.any(Number));
    expect(mockExec).toHaveBeenCalledWith('echo ON');
  });

  test('timeout fires setCharacteristic(On, false) after the configured delay', async () => {
    // The auto-off uses setCharacteristic (not updateCharacteristic) so that
    // onSet fires, offCmd runs, and state is persisted when the timer expires.
    const { sw, service } = makeSwitch({ delay: 5000, delayUnit: 'ms' });
    await sw.storageReady;
    await sw.switchSetOn(true);
    jest.runAllTimers();
    expect(service.setCharacteristic).toHaveBeenCalledWith(MockCharacteristic.On, false);
  });

  test('turning OFF clears the timeout and executes offCmd', async () => {
    // Manual OFF before the timer fires must cancel the pending auto-off and
    // still run offCmd.
    const { sw, service } = makeSwitch({ delay: 5000, delayUnit: 'ms' });
    await sw.storageReady;
    await sw.switchSetOn(true);
    await sw.switchSetOn(false);
    expect(mockExec).toHaveBeenCalledWith('echo OFF');
    // Timer was cleared so setCharacteristic should not be called
    jest.runAllTimers();
    expect(service.setCharacteristic).not.toHaveBeenCalled();
  });

  test('delayUnit "s" fires timeout after delay * 1000 ms', async () => {
    // Verifies the unit-conversion math: a mis-computed delayFactor would
    // fire too early or too late.
    const { sw, service } = makeSwitch({ delay: 5, delayUnit: 's' });
    await sw.storageReady;
    await sw.switchSetOn(true);
    jest.advanceTimersByTime(4999);
    expect(service.setCharacteristic).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(service.setCharacteristic).toHaveBeenCalledWith(MockCharacteristic.On, false);
  });

  test('delayUnit "min" fires timeout after delay * 60000 ms', async () => {
    // Same precision check for minutes.
    const { sw, service } = makeSwitch({ delay: 1, delayUnit: 'min' });
    await sw.storageReady;
    await sw.switchSetOn(true);
    jest.advanceTimersByTime(59999);
    expect(service.setCharacteristic).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(service.setCharacteristic).toHaveBeenCalledWith(MockCharacteristic.On, false);
  });

  test('manual OFF before timer expires removes startTime from storage', async () => {
    // Ensures a manual OFF clears the persisted startTime so that a Homebridge
    // restart after the manual OFF does not incorrectly restore the switch to ON.
    const { sw } = makeSwitch({ delay: 5000, delayUnit: 'ms' });
    await sw.storageReady;
    await sw.switchSetOn(true);
    mockStorage.removeItem.mockClear();
    await sw.switchSetOn(false);
    expect(mockStorage.removeItem).toHaveBeenCalledWith('TestSwitch - startTime');
  });

  test('second ON before first timer fires cancels the first timeout', async () => {
    // Guards against a leaked timeout when onSet(true) is called twice in
    // rapid succession. Only one auto-off timer should be active at a time.
    const { sw, service } = makeSwitch({ delay: 5000, delayUnit: 'ms' });
    await sw.storageReady;
    await sw.switchSetOn(true);
    await sw.switchSetOn(true); // second ON while first timer is still pending
    // Advance past one full delay: only one setCharacteristic call should occur,
    // not two (which would happen if the first timer were leaked).
    jest.runAllTimers();
    expect(service.setCharacteristic).toHaveBeenCalledTimes(1);
    expect(service.setCharacteristic).toHaveBeenCalledWith(MockCharacteristic.On, false);
  });

});

// ============================================================================
// 5. _restoreState - Stateful Switch
//
// These tests verify that after a Homebridge restart a real user toggle is
// always executed - the internal cache-restore path must not suppress command
// execution on the first post-restart interaction.
// ============================================================================

describe('_restoreState - stateful switch', () => {
  test('no cached state -> updateCharacteristic called with false', async () => {
    // No prior state means the switch was never used; default to OFF without
    // triggering onSet.
    mockStorage.getItem.mockResolvedValue(undefined);
    const { sw, service } = makeSwitch({ stateful: true });
    await sw.storageReady;
    expect(service.updateCharacteristic).toHaveBeenCalledWith(MockCharacteristic.On, false);
  });

  test('no cached state -> first real toggle executes command normally', async () => {
    // Confirms that the absence of cached state does not suppress the first
    // user-initiated command.
    mockStorage.getItem.mockResolvedValue(undefined);
    const { sw } = makeSwitch({ stateful: true });
    await sw.storageReady;
    mockExec.mockClear();
    await sw.switchSetOn(true);
    expect(mockExec).toHaveBeenCalledWith('echo ON');
  });

  test('cached state = true -> updateCharacteristic called with true', async () => {
    // ON state must be silently restored to HomeKit without triggering onSet
    // (which would re-run the command).
    mockStorage.getItem.mockResolvedValue(true);
    const { sw, service } = makeSwitch({ stateful: true });
    await sw.storageReady;
    expect(service.updateCharacteristic).toHaveBeenCalledWith(MockCharacteristic.On, true);
  });

  test('cached state = false -> updateCharacteristic called with false', async () => {
    // Same for OFF state.
    mockStorage.getItem.mockResolvedValue(false);
    const { sw, service } = makeSwitch({ stateful: true });
    await sw.storageReady;
    expect(service.updateCharacteristic).toHaveBeenCalledWith(MockCharacteristic.On, false);
  });

  test('cached state = null -> restores to OFF (only true restores to ON)', async () => {
    // node-persist can return null for a corrupted or manually-edited storage
    // file. The restore guard uses === true so any value that is not exactly
    // true (including null, undefined, false) safely defaults to OFF.
    mockStorage.getItem.mockResolvedValue(null);
    const { sw, service } = makeSwitch({ stateful: true });
    await sw.storageReady;
    expect(service.updateCharacteristic).toHaveBeenCalledWith(MockCharacteristic.On, false);
  });

  // -- Post-restart command-execution tests ----------------------------------

  test('cached ON -> first real user toggle (OFF) executes offCmd', async () => {
    mockStorage.getItem.mockResolvedValue(true); // switch was ON when Homebridge last stopped
    const { sw } = makeSwitch({ stateful: true });
    await sw.storageReady;
    mockExec.mockClear();
    mockStorage.setItem.mockClear();

    await sw.switchSetOn(false); // first real user action after restart

    expect(mockExec).toHaveBeenCalledWith('echo OFF'); // must not be skipped
  });

  test('cached OFF -> first real user toggle (ON) executes onCmd', async () => {
    mockStorage.getItem.mockResolvedValue(false); // switch was OFF when Homebridge last stopped
    const { sw } = makeSwitch({ stateful: true });
    await sw.storageReady;
    mockExec.mockClear();
    mockStorage.setItem.mockClear();

    await sw.switchSetOn(true); // first real user action after restart

    expect(mockExec).toHaveBeenCalledWith('echo ON'); // must not be skipped
  });

  test('consecutive toggles after restart all execute commands', async () => {
    // Both commands must fire - no internal guard must block any real user action
    mockStorage.getItem.mockResolvedValue(true);
    const { sw } = makeSwitch({ stateful: true });
    await sw.storageReady;
    mockExec.mockClear();
    await sw.switchSetOn(false); // first toggle
    await sw.switchSetOn(true);  // second toggle
    expect(mockExec).toHaveBeenCalledTimes(2);
    expect(mockExec).toHaveBeenNthCalledWith(2, 'echo ON');
  });
});

// ============================================================================
// 6. _restoreState - Non-Stateful (Temporary) Switch
// ============================================================================

describe('_restoreState - temporary switch', () => {
  test('no cached startTime -> no state restored', async () => {
    // If Homebridge stopped while the switch was already OFF, nothing should
    // be restored on restart.
    mockStorage.getItem.mockResolvedValue(undefined);
    const { sw, service } = makeSwitch({ delay: 5000 });
    await sw.storageReady;
    expect(service.updateCharacteristic).not.toHaveBeenCalledWith(MockCharacteristic.On, true);
  });

  test('cached startTime with remaining delay -> restores ON and schedules timeout', async () => {
    // When Homebridge restarts mid-delay, the switch must resume as ON with a
    // timeout for the remaining time, not the full delay.
    const elapsed = 2000;
    mockStorage.getItem.mockResolvedValue(Date.now() - elapsed); // 2s of 5s elapsed
    const { sw, service } = makeSwitch({ delay: 5000, delayUnit: 'ms' });
    await sw.storageReady;
    expect(service.updateCharacteristic).toHaveBeenCalledWith(MockCharacteristic.On, true);
    jest.runAllTimers();
    expect(service.setCharacteristic).toHaveBeenCalledWith(MockCharacteristic.On, false);
  });

  test('cached startTime already expired -> no restore, no timeout scheduled', async () => {
    // If the delay window has already passed by the time Homebridge restarts,
    // the switch should come up as OFF with no pending timer.
    mockStorage.getItem.mockResolvedValue(Date.now() - 10000); // 10s elapsed of 5s delay
    const { sw, service } = makeSwitch({ delay: 5000, delayUnit: 'ms' });
    await sw.storageReady;
    expect(service.updateCharacteristic).not.toHaveBeenCalledWith(MockCharacteristic.On, true);
    jest.runAllTimers();
    expect(service.setCharacteristic).not.toHaveBeenCalled();
  });

  test('cached startTime at exact delay boundary -> no restore', async () => {
    // The restore condition is diffTime < delay (strict less-than). If the
    // full delay has elapsed exactly, the switch expired cleanly and must
    // come up as OFF with no pending timer.
    const delay = 5000;
    mockStorage.getItem.mockResolvedValue(Date.now() - delay); // diffTime === delay
    const { sw, service } = makeSwitch({ delay, delayUnit: 'ms' });
    await sw.storageReady;
    expect(service.updateCharacteristic).not.toHaveBeenCalledWith(MockCharacteristic.On, true);
    jest.runAllTimers();
    expect(service.setCharacteristic).not.toHaveBeenCalled();
  });

  test('restore timeout fires at remaining time, not full delay', async () => {
    // Verifies the remaining-time calculation: with 2s elapsed of a 5s delay,
    // the timeout must fire at exactly 3000ms, not 5000ms.
    const elapsed = 2000;
    mockStorage.getItem.mockResolvedValue(Date.now() - elapsed);
    const { sw, service } = makeSwitch({ delay: 5000, delayUnit: 'ms' });
    await sw.storageReady;
    jest.advanceTimersByTime(2999); // 1ms before the 3s mark
    expect(service.setCharacteristic).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(service.setCharacteristic).toHaveBeenCalledWith(MockCharacteristic.On, false);
  });

  test('after mid-delay restart, onSet(false) from timer expiry executes offCmd', async () => {
    // Regression test: after a restart with remaining delay, when the auto-off
    // timer fires and Homebridge propagates setCharacteristic to onSet(false),
    // offCmd must NOT be suppressed.
    const elapsed = 2000;
    mockStorage.getItem.mockResolvedValue(Date.now() - elapsed);
    const { sw } = makeSwitch({ delay: 5000, delayUnit: 'ms' });
    await sw.storageReady;
    mockExec.mockClear();
    // Simulate Homebridge calling onSet(false) when the restore timeout fires
    await sw.switchSetOn(false);
    expect(mockExec).toHaveBeenCalledWith('echo OFF');
  });
});

// ============================================================================
// 7. _restoreState - Interactive Delay
// ============================================================================

describe('_restoreState - interactive delay', () => {
  const idConfig = {
    delay: 500,
    interactiveDelaySettings: {
      interactiveDelay: true,
      delayMin: 100,
      delayMax: 1000,
      delayStep: 100,
    },
  };

  test('no cached interactiveDelay -> updateCharacteristic with clamped config delay', async () => {
    // On first run (no cached value), the slider must be initialised to the
    // config delay clamped within [delayMin, delayMax].
    // delay=500 is within [100, 1000] so no clamping occurs here.
    mockStorage.getItem.mockResolvedValue(undefined);
    const { sw, service } = makeSwitch(idConfig);
    await sw.storageReady;
    expect(service.updateCharacteristic).toHaveBeenCalledWith(MockCharacteristic.Delay, 500);
  });

  test('cached interactiveDelay within range -> uses cached value and updates this.delay', async () => {
    // this.delay must be updated so subsequent ON calls use the user's
    // persisted slider value rather than the original config value.
    mockStorage.getItem.mockImplementation((key) =>
      key === 'TestSwitch - interactiveDelay'
        ? Promise.resolve(750)
        : Promise.resolve(undefined)
    );
    const { sw, service } = makeSwitch(idConfig);
    await sw.storageReady;
    expect(sw.delay).toBe(750);
    expect(service.updateCharacteristic).toHaveBeenCalledWith(MockCharacteristic.Delay, 750);
  });

  test('cached interactiveDelay below delayMin -> clamped to delayMin', async () => {
    // A stored value outside the current config range (e.g. config changed
    // since last run) must not pass an invalid ms value to setTimeout.
    mockStorage.getItem.mockImplementation((key) =>
      key === 'TestSwitch - interactiveDelay'
        ? Promise.resolve(50)
        : Promise.resolve(undefined)
    );
    const { sw, service } = makeSwitch(idConfig);
    await sw.storageReady;
    expect(sw.delay).toBe(100);
    expect(service.updateCharacteristic).toHaveBeenCalledWith(MockCharacteristic.Delay, 100);
  });

  test('cached interactiveDelay above delayMax -> clamped to delayMax', async () => {
    // Same upper-bound guard.
    mockStorage.getItem.mockImplementation((key) =>
      key === 'TestSwitch - interactiveDelay'
        ? Promise.resolve(2000)
        : Promise.resolve(undefined)
    );
    const { sw, service } = makeSwitch(idConfig);
    await sw.storageReady;
    expect(sw.delay).toBe(1000);
    expect(service.updateCharacteristic).toHaveBeenCalledWith(MockCharacteristic.Delay, 1000);
  });

  test('config delay below delayMin -> clamped to delayMin when no cached value', async () => {
    // keepIntInRange must clamp the initial config value if it falls outside
    // the declared slider bounds.
    mockStorage.getItem.mockResolvedValue(undefined);
    const { sw, service } = makeSwitch({ ...idConfig, delay: 50 });
    await sw.storageReady;
    expect(service.updateCharacteristic).toHaveBeenCalledWith(MockCharacteristic.Delay, 100);
  });

  test('config delay above delayMax -> clamped to delayMax when no cached value', async () => {
    // Same for the upper bound.
    mockStorage.getItem.mockResolvedValue(undefined);
    const { sw, service } = makeSwitch({ ...idConfig, delay: 1500 });
    await sw.storageReady;
    expect(service.updateCharacteristic).toHaveBeenCalledWith(MockCharacteristic.Delay, 1000);
  });

  test('mid-delay restart uses cached interactive delay, not config default, for remaining timeout', async () => {
    // Config delay=5000ms, but the user had set the slider to 8000ms.
    // Homebridge restarts 6000ms in. If the code incorrectly used the config
    // default (5000ms), diffTime(6000) >= delay(5000) → no restore at all.
    // Using the cached value (8000ms) gives 2000ms remaining: the switch
    // must come up as ON and the timeout must fire at exactly 2000ms.
    const cachedDelay = 8000;
    const elapsed = 6000;
    mockStorage.getItem.mockImplementation((key) => {
      if (key === 'TestSwitch - interactiveDelay') return Promise.resolve(cachedDelay);
      if (key === 'TestSwitch - startTime') return Promise.resolve(Date.now() - elapsed);
      return Promise.resolve(undefined);
    });
    const { sw, service } = makeSwitch({
      delay: 5000,
      interactiveDelaySettings: {
        interactiveDelay: true,
        delayMin: 1000,
        delayMax: 10000,
        delayStep: 1000,
      },
    });
    await sw.storageReady;
    expect(sw.delay).toBe(cachedDelay);
    expect(service.updateCharacteristic).toHaveBeenCalledWith(MockCharacteristic.On, true);
    jest.advanceTimersByTime(1999);
    expect(service.setCharacteristic).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(service.setCharacteristic).toHaveBeenCalledWith(MockCharacteristic.On, false);
  });
});

// ============================================================================
// 8. switchSetDelay
// ============================================================================

describe('switchSetDelay', () => {
  const idConfig = {
    delay: 500,
    interactiveDelaySettings: {
      interactiveDelay: true,
      delayMin: 100,
      delayMax: 1000,
      delayStep: 100,
    },
  };

  test('updates this.delay and persists to storage', async () => {
    // this.delay must be mutated immediately so the next ON uses the new
    // value, and the value must be persisted so it survives a restart.
    const { sw } = makeSwitch(idConfig);
    await sw.storageReady;
    await sw.switchSetDelay(700);
    expect(sw.delay).toBe(700);
    expect(mockStorage.setItem).toHaveBeenCalledWith('TestSwitch - interactiveDelay', 700);
  });

  test('new delay is used for subsequent ON', async () => {
    // Confirms end-to-end that a slider change flows through to the auto-off
    // timeout duration.
    const { sw, service } = makeSwitch(idConfig);
    await sw.storageReady;
    await sw.switchSetDelay(300);
    await sw.switchSetOn(true);
    // Timeout should be set for 300ms (300 * delayFactor 1)
    jest.advanceTimersByTime(299);
    expect(service.setCharacteristic).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(service.setCharacteristic).toHaveBeenCalledWith(MockCharacteristic.On, false);
  });

  test('logs error and skips setItem when storage init fails', async () => {
    // When storage.init() rejects, storageAvailable stays false and
    // switchSetDelay must log an error and not persist the delay change.
    mockStorage.init.mockRejectedValue(new Error('disk full'));
    const { sw } = makeSwitch(idConfig);
    await sw.storageReady;
    await sw.switchSetDelay(400);
    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('storage unavailable'));
    expect(mockStorage.setItem).not.toHaveBeenCalledWith('TestSwitch - interactiveDelay', expect.anything());
  });

  test('this.delay is updated synchronously before storage write completes', async () => {
    // switchSetDelay sets this.delay as its first statement, before awaiting
    // storageReady. The in-memory delay is therefore immediately available for
    // any switchSetOn call that follows, even if the persist write is still
    // pending.
    const { sw } = makeSwitch(idConfig);
    const delayPromise = sw.switchSetDelay(400); // do NOT await yet
    expect(sw.delay).toBe(400);                  // updated before any await
    await delayPromise;
    expect(mockStorage.setItem).toHaveBeenCalledWith('TestSwitch - interactiveDelay', 400);
  });
});

// ============================================================================
// 9. Storage Unavailable (switchSetOn)
// ============================================================================

describe('storage unavailable - switchSetOn', () => {
  test('logs error and does not execute command when storage init fails', async () => {
    // When storage.init() rejects, storageAvailable stays false and
    // switchSetOn must log an error and bail out without running any command.
    mockStorage.init.mockRejectedValue(new Error('storage gone'));
    const { sw } = makeSwitch({ stateful: true });
    await sw.storageReady;
    await sw.switchSetOn(true);
    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('storage unavailable'));
    expect(mockExec).not.toHaveBeenCalled();
  });

  test('does not save state to storage when storage init fails', async () => {
    // Confirms that the early return on storage failure also prevents a
    // partial setItem write.
    mockStorage.init.mockRejectedValue(new Error('storage gone'));
    const { sw } = makeSwitch({ stateful: true });
    await sw.storageReady;
    await sw.switchSetOn(true);
    expect(mockStorage.setItem).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 10. storageAvailable flag
// ============================================================================

describe('storageAvailable flag', () => {
  test('storageAvailable is false immediately after construction', () => {
    // The flag starts false and is only set true after the async init chain
    // completes. Code that runs synchronously after construction (like an
    // immediate switchSetOn call) must observe the false state.
    const { sw } = makeSwitch();
    expect(sw.storageAvailable).toBe(false);
  });

  test('storageAvailable is true after successful init', async () => {
    // Verifies the flag is correctly set by the .then() that follows
    // _restoreState(); guards against accidentally removing that assignment.
    const { sw } = makeSwitch();
    await sw.storageReady;
    expect(sw.storageAvailable).toBe(true);
  });

  test('storageAvailable stays false when storage.init() rejects', async () => {
    // If the storage backend is unavailable at startup, the flag must remain
    // false so every subsequent handler call is blocked.
    mockStorage.init.mockRejectedValue(new Error('disk full'));
    const { sw } = makeSwitch();
    await sw.storageReady;
    expect(sw.storageAvailable).toBe(false);
  });

  test('storageAvailable stays false when _restoreState throws, and commands are blocked', async () => {
    // init() succeeds but getItem() throws during restore. The error is caught
    // by the constructor .catch(), storageAvailable stays false, and subsequent
    // calls to switchSetOn must be blocked rather than partially executing.
    mockStorage.getItem.mockRejectedValue(new Error('read error'));
    const { sw } = makeSwitch({ stateful: true });
    await sw.storageReady;
    expect(sw.storageAvailable).toBe(false);
    await sw.switchSetOn(true);
    expect(mockExec).not.toHaveBeenCalled();
    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('storage unavailable'));
  });
});
