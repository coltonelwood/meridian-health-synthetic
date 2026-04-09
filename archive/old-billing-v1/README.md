# Legacy Billing System v1 (DEPRECATED)

> **DEPRECATED: v1 billing system. Replaced by `services/billing` in 2024. Some historical reports still reference these table structures.**

## Overview

This was the original billing calculation engine written in Python. It handled:

- Copay, deductible, and coinsurance calculations
- Payer contract rate lookups
- Patient responsibility estimation
- Statement generation (PDF)

## Why It Was Replaced

1. The procedural code became unmaintainable as we added more payer contracts
2. No unit tests (we were young and foolish)
3. The PDF generation had persistent formatting bugs
4. No support for bundled payments or value-based care models
5. Couldn't handle split billing or coordination of benefits well

## Historical Table Structures

If you need to understand the old billing tables for historical reports, the key tables were:

- `billing_v1.charges` - Raw charges
- `billing_v1.payments` - Payments received
- `billing_v1.adjustments` - Contractual adjustments
- `billing_v1.statements` - Generated statements
- `billing_v1.payer_contracts` - Payer fee schedules

These tables still exist in the database (read-only) and are used by some legacy Crystal Reports.

## Contact

Questions? Ask **Priya Sharma** (Revenue Cycle Team) or **James Liu** (Data Engineering).
