---
type: "Concept"
title: "Footprint lock holding states"
description: "Which Linear statuses may keep a Valkey footprint lock, and why Completed zombies are reconciled on the tick."
tags: [locks, footprint, scheduler, linear]
timestamp: "2026-08-07T00:00:00Z"
---

# Footprint lock holding states

A Valkey hash field under `orch:…:locks` is acquired when an issue enters **In Progress** and is normally released on **Completed** (webhook). There is **no TTL** on the hash field: **Blocked** may keep the lock for an unbounded time until a human moves the issue.

States that may hold a lock:

- In Progress, Code Review, In Review, Reopened, Pending Merge, Blocked

Any other state (notably Completed, Planned, To Do, Refining, Backlog) must not hold a lock. The tick's `reconcileStaleLocks()` enforces that against Linear when the release webhook was missed.
