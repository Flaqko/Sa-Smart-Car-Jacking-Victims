// Smart Carjacking Victims - CLEO Redux JavaScript v1.0
// GTA San Andreas Classic
//
// Behaviour:
// - Detects when CJ actually starts entering a car that already has a driver.
// - Confirms the carjacking only after the original driver is fully out and stably on foot.
// - Remembers the original driver + exact vehicle without taking script ownership.
// - If that same victim later gets back into the same vehicle (driver OR passenger),
//   the vehicle is locked against the player (CarLock.LockoutPlayerOnly).
// - The lock is restored when the victim stops driving, dies, the car is lost,
//   or the script leaves free-roam/exterior gameplay.
//
// v1.0 release:
// - Based directly on the user-tested v0.3 TEST build.
// - Gameplay logic is unchanged from that confirmed-working baseline.
// - Release default disables diagnostic event logging.
//
// No ped pool scans, no spawning, no forced AI tasks, no memory access.
// CLEO+ is not required.

/// <reference path=".config/sa.d.ts" />

// -----------------------------------------------------------------------------
// Settings
// -----------------------------------------------------------------------------

const DEBUG = false;

// 50 ms is fast enough to catch CJ's normal vehicle-entry animation while
// remaining extremely light: only CJ + a tiny list of previously stolen cars.
const CHECK_INTERVAL_MS = 50;

// CJ has this long to complete the entry after we see an occupied target car.
const CARJACK_CONFIRM_TIMEOUT_MS = 20000;

// Require the displaced driver to remain fully outside/on foot for this long.
// This prevents a transient driver-handle change during the pull-out animation
// from being mistaken for a completed ejection.
const EJECTION_SETTLE_MS = 600;

// If the victim has not reclaimed the car after this long, stop remembering it.
// Once the victim DOES reclaim it, tracking stays active until they leave the car.
const RECLAIM_WAIT_TIMEOUT_MS = 120000;

// Avoid an unbounded list if the player rapidly steals many occupied vehicles.
const MAX_TRACKED_CARJACKS = 8;

// Sanny Builder / GTA SA CarLock enum.
const CAR_LOCK_UNLOCKED = 1;
const CAR_LOCK_LOCKOUT_PLAYER_ONLY = 3;

// -----------------------------------------------------------------------------
// Runtime state
// -----------------------------------------------------------------------------

// Temporary entry attempt. It becomes a tracked carjacking only after CJ is
// actually observed being removed from the occupied driver seat.
let candidate = null;

// Entries:
// {
//   ped, car, pedModel, carModel, stolenAt,
//   reclaimed, previousLock, lockAppliedByUs
// }
const tracked = [];

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function debug(message) {
    if (DEBUG) {
        log("[SmartCarjackingVictims] " + message);
    }
}

function numberResult(value, fallback = -1) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (value && typeof value === "object") {
        const keys = Object.keys(value);

        for (let i = 0; i < keys.length; i++) {
            const item = value[keys[i]];

            if (typeof item === "number" && Number.isFinite(item)) {
                return item;
            }
        }
    }

    return fallback;
}

function charExists(ped) {
    return Number.isInteger(ped) &&
        ped >= 0 &&
        !!native("DOES_CHAR_EXIST", ped);
}

function vehicleExists(car) {
    return Number.isInteger(car) &&
        car >= 0 &&
        !!native("DOES_VEHICLE_EXIST", car);
}

function getCharModel(ped) {
    if (!charExists(ped)) return -1;
    return numberResult(native("GET_CHAR_MODEL", ped));
}

function getCarModel(car) {
    if (!vehicleExists(car)) return -1;
    return numberResult(native("GET_CAR_MODEL", car));
}

function getDriver(car) {
    if (!vehicleExists(car)) return -1;
    return numberResult(native("GET_DRIVER_OF_CAR", car));
}

function isActualCar(car) {
    const model = getCarModel(car);

    if (model < 0) return false;

    // Deliberately excludes motorcycles, bicycles, boats, aircraft, etc.
    return !!native("IS_THIS_MODEL_A_CAR", model);
}

function isFreeRoamExterior(cj) {
    if (ONMISSION) return false;
    if (!charExists(cj)) return false;
    if (native("IS_CHAR_DEAD", cj)) return false;

    return numberResult(
        native("GET_CHAR_AREA_VISIBLE", cj),
        0
    ) === 0;
}

function getDoorLockStatus(car) {
    if (!vehicleExists(car)) return CAR_LOCK_UNLOCKED;

    try {
        const status = numberResult(
            native("GET_CAR_DOOR_LOCK_STATUS", car),
            CAR_LOCK_UNLOCKED
        );

        return status >= 0 ? status : CAR_LOCK_UNLOCKED;
    } catch (e) {
        return CAR_LOCK_UNLOCKED;
    }
}

function setDoorLockStatus(car, status) {
    if (!vehicleExists(car)) return false;

    try {
        native("LOCK_CAR_DOORS", car, status);
        return true;
    } catch (e) {
        debug(
            "Could not set door lock for car " +
            car +
            ": " +
            e
        );
        return false;
    }
}

function signaturesStillMatch(entry) {
    if (!charExists(entry.ped) || !vehicleExists(entry.car)) {
        return false;
    }

    return getCharModel(entry.ped) === entry.pedModel &&
        getCarModel(entry.car) === entry.carModel;
}

function findTrackedCar(car) {
    for (let i = 0; i < tracked.length; i++) {
        if (tracked[i].car === car) {
            return i;
        }
    }

    return -1;
}

// Restore only a lock that THIS script actually applied, and only if the car is
// still using our LockoutPlayerOnly state. This avoids fighting another mod that
// may deliberately change the lock after us.
function restoreLockIfOurs(entry) {
    if (!entry.lockAppliedByUs || !vehicleExists(entry.car)) {
        return;
    }

    if (getDoorLockStatus(entry.car) !== CAR_LOCK_LOCKOUT_PLAYER_ONLY) {
        return;
    }

    setDoorLockStatus(entry.car, entry.previousLock);
}

function removeTrackedAt(index, reason) {
    const entry = tracked[index];

    if (!entry) return;

    restoreLockIfOurs(entry);

    debug(
        "Stopped tracking victim " +
        entry.ped +
        " / car " +
        entry.car +
        ": " +
        reason +
        "."
    );

    tracked.splice(index, 1);
}

function clearAll(reason) {
    candidate = null;

    for (let i = tracked.length - 1; i >= 0; i--) {
        removeTrackedAt(i, reason);
    }
}

// -----------------------------------------------------------------------------
// Carjacking detection
// -----------------------------------------------------------------------------

function captureEntryCandidate(cj, now) {
    // This GTA command is the important filter: simply being near a vehicle or
    // having just left one is not enough. CJ must actually be entering a car.
    if (!native("IS_CHAR_GETTING_IN_TO_A_CAR", cj)) {
        return;
    }

    const car = numberResult(
        native("GET_CAR_CHAR_IS_USING", cj)
    );

    if (!vehicleExists(car) || !isActualCar(car)) {
        return;
    }

    const victim = getDriver(car);

    // An occupied driver seat is required at the moment CJ starts the entry.
    // Empty-car entry therefore can never become a tracked carjacking.
    if (
        !charExists(victim) ||
        victim === cj ||
        native("IS_CHAR_DEAD", victim) ||
        !native("IS_CHAR_SITTING_IN_CAR", victim, car)
    ) {
        return;
    }

    // Repeated 50 ms samples during the same entry animation should not spam.
    if (
        candidate &&
        candidate.car === car &&
        candidate.ped === victim
    ) {
        return;
    }

    candidate = {
        ped: victim,
        car: car,
        pedModel: getCharModel(victim),
        carModel: getCarModel(car),
        capturedAt: now,
        ejectedAt: 0
    };

    debug(
        "Occupied entry detected: possible victim " +
        victim +
        " in car " +
        car +
        "."
    );
}

function confirmCandidate(cj, now) {
    if (!candidate) return;

    if (now - candidate.capturedAt >= CARJACK_CONFIRM_TIMEOUT_MS) {
        debug(
            "Entry candidate expired for victim " +
            candidate.ped +
            " / car " +
            candidate.car +
            "."
        );
        candidate = null;
        return;
    }

    if (
        !charExists(candidate.ped) ||
        !vehicleExists(candidate.car) ||
        getCharModel(candidate.ped) !== candidate.pedModel ||
        getCarModel(candidate.car) !== candidate.carModel
    ) {
        candidate = null;
        return;
    }

    // v0.3: seeing the driver handle disappear is NOT enough. During the
    // pull-out animation GTA can temporarily report the seat differently.
    // The original driver must be completely outside this car, in no vehicle,
    // and stably on foot for EJECTION_SETTLE_MS before we remember the theft.
    const victimStillInTargetCar =
        !!native("IS_CHAR_SITTING_IN_CAR", candidate.ped, candidate.car);

    const victimInAnyCar =
        !!native("IS_CHAR_IN_ANY_CAR", candidate.ped);

    const victimOnFoot =
        !!native("IS_CHAR_ON_FOOT", candidate.ped);

    if (victimStillInTargetCar || victimInAnyCar || !victimOnFoot) {
        candidate.ejectedAt = 0;
        return;
    }

    if (!candidate.ejectedAt) {
        candidate.ejectedAt = now;
        debug(
            "Victim " +
            candidate.ped +
            " is fully outside car " +
            candidate.car +
            "; confirming after settle window."
        );
        return;
    }

    if (now - candidate.ejectedAt < EJECTION_SETTLE_MS) {
        return;
    }

    const oldIndex = findTrackedCar(candidate.car);

    if (oldIndex >= 0) {
        removeTrackedAt(oldIndex, "same car was carjacked again");
    }

    if (tracked.length >= MAX_TRACKED_CARJACKS) {
        removeTrackedAt(0, "tracking list limit reached");
    }

    tracked.push({
        ped: candidate.ped,
        car: candidate.car,
        pedModel: candidate.pedModel,
        carModel: candidate.carModel,
        stolenAt: now,
        reclaimed: false,
        previousLock: CAR_LOCK_UNLOCKED,
        lockAppliedByUs: false
    });

    debug(
        "Carjacking confirmed after full ejection: victim " +
        candidate.ped +
        " was pulled out of car " +
        candidate.car +
        ". Waiting to see if they get back in."
    );

    candidate = null;
}

// -----------------------------------------------------------------------------
// Victim reclaim / lock behaviour
// -----------------------------------------------------------------------------

function processTracked(now) {
    for (let i = tracked.length - 1; i >= 0; i--) {
        const entry = tracked[i];

        if (!signaturesStillMatch(entry)) {
            removeTrackedAt(i, "ped or vehicle disappeared / handle changed");
            continue;
        }

        if (native("IS_CHAR_DEAD", entry.ped)) {
            removeTrackedAt(i, "original victim died");
            continue;
        }

        if (native("IS_CAR_DEAD", entry.car)) {
            removeTrackedAt(i, "vehicle was destroyed");
            continue;
        }

        // The original victim only has to get fully back into the exact same vehicle.
        // Driver or passenger both count. IS_CHAR_SITTING_IN_CAR deliberately
        // waits for the entry animation to finish before the lock is applied.
        const victimIsBackInCar =
            !!native("IS_CHAR_SITTING_IN_CAR", entry.ped, entry.car);

        if (!entry.reclaimed) {
            if (victimIsBackInCar) {
                entry.previousLock = getDoorLockStatus(entry.car);
                entry.lockAppliedByUs =
                    entry.previousLock !== CAR_LOCK_LOCKOUT_PLAYER_ONLY;

                if (entry.lockAppliedByUs) {
                    setDoorLockStatus(
                        entry.car,
                        CAR_LOCK_LOCKOUT_PLAYER_ONLY
                    );
                }

                entry.reclaimed = true;

                debug(
                    "Victim " +
                    entry.ped +
                    " got back into car " +
                    entry.car +
                    "; doors are now locked against CJ."
                );

                continue;
            }

            if (now - entry.stolenAt >= RECLAIM_WAIT_TIMEOUT_MS) {
                removeTrackedAt(i, "victim did not reclaim car before timeout");
            }

            continue;
        }

        // The 'lesson learned' lock lasts while the original victim remains in
        // the car. Once they get out, restore the prior lock state and return
        // the vehicle completely to vanilla behaviour.
        if (!victimIsBackInCar) {
            removeTrackedAt(i, "original victim left the car");
        }
    }
}

// -----------------------------------------------------------------------------
// Main loop
// -----------------------------------------------------------------------------

log(
    "[SmartCarjackingVictims] v1.0 loaded - fully ejected victims lock their reclaimed car against CJ."
);

while (true) {
    wait(CHECK_INTERVAL_MS);

    if (!native("IS_PLAYER_PLAYING", 0)) {
        if (candidate || tracked.length > 0) {
            clearAll("player unavailable");
        }
        continue;
    }

    const cj = numberResult(native("GET_PLAYER_CHAR", 0));

    if (!isFreeRoamExterior(cj)) {
        if (candidate || tracked.length > 0) {
            clearAll("left free-roam exterior gameplay");
        }
        continue;
    }

    captureEntryCandidate(cj, Date.now());
    confirmCandidate(cj, Date.now());
    processTracked(Date.now());
}
