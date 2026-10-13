---
name: Database import scope
description: User-approved scope for the SGB-TP database setup.
---

Build the GitHub project with a fresh database based on the tables and fields in its code. The user explicitly requested table/field structure only, not data from the existing Neon database.

**Why:** The user asked not to take the database data.

**How to apply:** Prefer the repository's schema definitions. Do not import database dumps containing rows or seed copied user/business data. Do not access or alter the existing Neon database as part of this build.
