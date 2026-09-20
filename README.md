# Smart Carjacking Victims v1.0

A small immersion mod for **GTA San Andreas Classic** using **CLEO Redux JavaScript**.

## What it does

When CJ carjacks a vehicle that already has a driver, the mod remembers the original victim only after that ped has been **fully pulled out and stably on foot**. If that same victim later gets **fully seated back inside the exact same vehicle**, the vehicle is locked against CJ using GTA San Andreas' `LockoutPlayerOnly` door-lock state.

The victim may reclaim the vehicle as either the **driver or a passenger**. The lock is not applied during the ejection animation and is not applied while the victim is merely climbing back in.

## Behavior

1. CJ starts entering a car that already has a driver.
2. The original driver is pulled out.
3. The victim must be fully outside, in no vehicle, and on foot for 600 ms.
4. The mod remembers that exact ped + exact vehicle.
5. If the victim later gets fully seated back in that same vehicle, it locks against CJ.
6. When the original victim leaves the vehicle, dies, the vehicle is destroyed/lost, or free-roam exterior gameplay ends, the mod cleans up and restores the prior lock state when appropriate.

## Install

Place `SmartCarjackingVictims_v1.0.js` in your GTA San Andreas `CLEO` folder.

Remove older `SmartCarjackingVictims_*_TEST.js` builds first.

## Requirements

- GTA San Andreas Classic
- CLEO Redux
- No CLEO+ requirement
- No raw-memory permission

## Release notes

v1.0 is based directly on the **user-confirmed v0.3 TEST** build. Gameplay logic, timing, detection, reclaim rules, cleanup, and lock behavior are unchanged. Release changes are limited to version/release text and disabling diagnostic event logging by default.
