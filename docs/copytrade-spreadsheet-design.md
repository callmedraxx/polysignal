# Copy Trading Spreadsheet Design

This document outlines the spreadsheet structure for tracking copy trading positions.

## Google Sheets Columns (Auto-Created)

**Note:** Only these columns will appear in the Google Sheets. Additional fields (Position ID, Activity ID, Market Slug, Condition ID, Asset ID, etc.) are stored in the database but not displayed in the sheet.

### Column Structure (18 columns total)

| Column # | Column Name | Type | Description | Example | Formula |
|----------|-------------|------|-------------|---------|---------|
| 1 | **Wallet Address** | Text | Wallet address being copied | `0x1234...abcd` | From database |
| 2 | **Trader Name** | Text | Label/name of the trader/wallet | `WhaleTrader1` | From database |
| 3 | **Subscription Type** | Text | Subscription type (free/paid) | `free` or `paid` | From database |
| 4 | **Outcome Chosen** | Text | Outcome chosen at entry | `"Biden"` | From database |
| 5 | **Realized Outcome** | Text | Actual winning outcome (based on PNL) | `"Biden"` or `"Trump"` | Calculated from PNL |
| 6 | **Entry Date/Time** | Date/Time | When position was opened | `2024-11-03 10:30:00` | From database |
| 7 | **Entry Price** | Decimal | Entry price per share | `0.65` | From database |
| 8 | **Simulated Investment** | Decimal | USD amount invested | `500.00` | From database |
| 9 | **Shares Bought** | Decimal | Number of shares purchased | `769.23` | `=Investment / Entry Price` |
| 10 | **Exit Date** | Date/Time | When position was closed | `2024-11-04 15:45:00` | From database (if closed) |
| 11 | **Exit Price** | Decimal | Exit price per share | `0.85` | Calculated from closed position |
| 12 | **Shares Sold** | Decimal | Number of shares sold | `769.23` | Usually same as Shares Bought |
| 13 | **Realized PnL** | Decimal | Profit/Loss in USD | `153.85` | `=(Exit Price - Entry Price) × Shares Sold` |
| 14 | **Percent PnL** | Percentage | Percentage gain/loss | `30.77%` | `=(Realized PnL / Investment) × 100` |
| 15 | **Final Value** | Decimal | Final portfolio value | `653.85` | `=Investment + Realized PnL` |
| 16 | **ROI** | Percentage | Return on Investment | `30.77%` | Same as Percent PnL |
| 17 | **Status** | Text | Position status | `open`, `closed`, `partially_closed` | From database |
| 18 | **Hours Held** | Number | Number of hours position was open | `29.25` | `=(Exit Date - Entry Date) × 24` |

### Entry Data
| Column | Type | Description | Example | Formula |
|--------|------|-------------|---------|---------|
| **Entry Date** | Date/Time | When position was opened | `2024-11-03 10:30:00` | From activity timestamp |
| **Entry Price** | Decimal | Entry price per share | `0.65` | From BUY trade metadata |
| **Simulated Investment** | Decimal | USD amount invested | `500.00` | Configurable per wallet (default $500) |
| **Shares Bought** | Decimal | Number of shares purchased | `769.23` | `=Simulated Investment / Entry Price` |
| **Entry Transaction Hash** | Text | Transaction hash of entry | `0xabc123...` | From activity |

### Exit Data
| Column | Type | Description | Example | Formula |
|--------|------|-------------|---------|---------|
| **Exit Date** | Date/Time | When position was closed | `2024-11-04 15:45:00` | From closed position |
| **Exit Price** | Decimal | Exit price per share | `0.85` | Calculated: `(Total Cost + Realized PnL) / Total Bought` |
| **Shares Sold** | Decimal | Number of shares sold | `769.23` | Usually same as Shares Bought for fully closed |
| **Exit Transaction Hash** | Text | Transaction hash of exit | `0xdef456...` | From activity |

### P&L Calculations
| Column | Type | Description | Example | Formula |
|--------|------|-------------|---------|---------|
| **Realized PnL** | Decimal | Profit/Loss in USD | `153.85` | `=(Exit Price - Entry Price) * Shares Bought` |
| **Percent PnL** | Percentage | Percentage gain/loss | `30.77%` | `=(Realized PnL / Simulated Investment) * 100` |
| **Final Value** | Decimal | Final portfolio value | `653.85` | `=Simulated Investment + Realized PnL` |
| **ROI** | Percentage | Return on Investment | `30.77%` | Same as Percent PnL |

### Status
| Column | Type | Description | Example |
|--------|------|-------------|---------|
| **Status** | Text | Position status | `"open"`, `"closed"`, `"partially_closed"` |
| **Days Held** | Number | Number of days position was open | `1.22` | `=(Exit Date - Entry Date) / 1` |

## Calculation Formulas (Auto-Calculated in Sheets)

### Shares Bought (Column 9):
```
=IF(ISBLANK(H2), "", H2 / G2)
Where H2 = Simulated Investment, G2 = Entry Price
```

### Realized PnL (Column 13):
```
=IF(OR(ISBLANK(K2), ISBLANK(G2), ISBLANK(L2)), "", (K2 - G2) * L2)
Where K2 = Exit Price, G2 = Entry Price, L2 = Shares Sold
```

### Percent PnL (Column 14):
```
=IF(OR(ISBLANK(M2), ISBLANK(H2)), "", (M2 / H2) * 100)
Where M2 = Realized PnL, H2 = Simulated Investment
```

### Final Value (Column 15):
```
=IF(ISBLANK(M2), H2, H2 + M2)
Where M2 = Realized PnL, H2 = Simulated Investment
```

### ROI (Column 16):
```
=IF(ISBLANK(N2), "", N2)
Same as Percent PnL (Column 14)
```

### Hours Held (Column 18):
```
=IF(ISBLANK(J2), "", (J2 - F2) * 24)
Where J2 = Exit Date, F2 = Entry Date
```

## Google Sheets Layout Example

```
Row 1: Headers (frozen, bold, with background color)
Row 2+: Data rows

Header Row:
A: Wallet Address | B: Trader Name | C: Subscription Type | D: Outcome Chosen | E: Realized Outcome | F: Entry Date/Time | G: Entry Price | H: Simulated Investment | I: Shares Bought | J: Exit Date | K: Exit Price | L: Shares Sold | M: Realized PnL | N: Percent PnL | O: Final Value | P: ROI | Q: Status | R: Hours Held

Example Data Row:
0xee613...debf | Blackhawks Trader | free | Blackhawks | Kraken | 2024-11-03 10:30:00 | 0.40 | 500.00 | 1250.00 | 2024-11-04 15:45:00 | 0.0005 | 1250.00 | -499.38 | -99.88% | 0.62 | -99.88% | closed | 29.25
```

## Aggregate Views (Optional Additional Sheets)

### Summary Sheet
- Total Positions (Open/Closed)
- Total Invested
- Total Realized PnL
- Overall ROI
- Win Rate (% of profitable trades)
- Average Hold Time
- Best Trade
- Worst Trade

### Per-Wallet Summary
- Positions per wallet
- Total PnL per wallet
- ROI per wallet
- Win rate per wallet

### Per-Market Summary
- Positions per market
- Total volume per market
- Average ROI per market

## Notes

1. **Realized Outcome**: Determined by PNL sign:
   - If PNL ≥ 0: Use `closedPosition.outcome` (trader won)
   - If PNL < 0: Use `closedPosition.oppositeOutcome` (trader lost)

2. **Partial Closes**: If a position is partially closed:
   - Create new row for partial close with prorated shares
   - Keep original position open with remaining shares

3. **Multiple Entries**: If same wallet adds to a position:
   - Track as separate position OR
   - Aggregate into weighted average entry price

4. **Auto-Update**: The spreadsheet will be automatically updated when:
   - New BUY trade detected → New row created
   - Position closed → Row updated with exit data
   - Position partially closed → New row for partial + original updated

