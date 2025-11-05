# Copy Trading Spreadsheet Layout

## Visual Spreadsheet Structure

Here's how the spreadsheet should look with example data:

| Wallet Address | Trader Name | Is Tracked Whale | Position ID | Activity ID | Market Name | Market Slug | Condition ID | Asset ID | Outcome | Outcome Index | Realized Outcome | Entry Date | Entry Price | Simulated Investment | Shares Bought | Entry TX Hash | Exit Date | Exit Price | Shares Sold | Exit TX Hash | Realized PnL | Percent PnL | Final Value | ROI | Status | Days Held |
|----------------|-------------|------------------|-------------|-------------|-------------|-------------|--------------|----------|---------|---------------|------------------|------------|-------------|---------------------|---------------|---------------|-----------|------------|-------------|--------------|--------------|-------------|-------------|-----|---------|-----------|
| `0xee613...debf` | Blackhawks Trader | ✅ TRUE | `550e8400...` | `660e8400...` | Blackhawks vs. Kraken | `nhl-chi-sea-2025-11-03` | `0x211ea3...` | `450424533...` | Blackhawks | 0 | Kraken | 2025-11-03 10:30 | $0.40 | $500.00 | 1,250.00 | `0xabc123...` | 2025-11-04 15:45 | $0.0005 | 1,250.00 | `0xdef456...` | -$499.38 | -99.88% | $0.62 | -99.88% | closed | 1.22 |
| `0xee613...debf` | Blackhawks Trader | ✅ TRUE | `550e8400...` | `660e8400...` | Presidential Election | `presidential-election-2024` | `0x311ea3...` | `550424533...` | Biden | 0 | Biden | 2025-11-05 09:15 | $0.65 | $500.00 | 769.23 | `0xghi789...` | 2025-11-06 14:20 | $0.85 | 769.23 | `0xjkl012...` | +$153.85 | +30.77% | $653.85 | +30.77% | closed | 1.21 |
| `0x1234...5678` | CopyTrade Only | ❌ FALSE | `550e8400...` | `660e8400...` | Crypto Analysis | `crypto-market-analysis-2025` | `0x411ea3...` | `650424533...` | BTC Up | 0 | BTC Up | 2025-11-07 11:00 | $0.55 | $500.00 | 909.09 | `0xmno345...` | - | - | - | - | - | - | $500.00 | 0.00% | **open** | - |
| `0x9876...4321` | Whale Trader 2 | ✅ TRUE | `550e8400...` | `660e8400...` | Sports Betting | `sports-betting-2025` | `0x511ea3...` | `750424533...` | Team A Wins | 1 | Team B Wins | 2025-11-08 16:30 | $0.70 | $500.00 | 714.29 | `0xpqr678...` | 2025-11-09 12:00 | $0.30 | 714.29 | `0xstu901...` | -$285.71 | -57.14% | $214.29 | -57.14% | closed | 0.82 |

## Column Descriptions

### 📊 Wallet/Trader Information
- **Wallet Address**: The wallet address being copied
- **Trader Name**: Label/name for easy identification
- **Is Tracked Whale**: ✅ if also sends Discord alerts, ❌ if copytrade-only

### 📈 Trade Information
- **Position ID**: Unique identifier (UUID) for this simulated position
- **Activity ID**: Links to the original `WhaleActivity` that triggered this position
- **Market Name**: Display name of the market
- **Market Slug**: URL-friendly identifier (for generating links)
- **Condition ID**: Polymarket condition identifier
- **Asset ID**: Polymarket asset identifier
- **Outcome**: The outcome chosen by the trader (entry)
- **Outcome Index**: 0 or 1 (for binary markets)
- **Realized Outcome**: The actual winning outcome (determined by PNL sign)

### 💰 Entry Data
- **Entry Date**: When the position was opened (from activity timestamp)
- **Entry Price**: Price per share at entry (from BUY trade)
- **Simulated Investment**: USD amount invested (configurable, default $500)
- **Shares Bought**: Calculated as `Investment ÷ Entry Price`
- **Entry TX Hash**: Transaction hash of the entry trade

### 🚪 Exit Data
- **Exit Date**: When the position was closed
- **Exit Price**: Price per share at exit (calculated from closed position)
- **Shares Sold**: Number of shares sold (usually same as bought for fully closed)
- **Exit TX Hash**: Transaction hash of the exit trade

### 📊 P&L Calculations
- **Realized PnL**: Profit or loss in USD (`(Exit Price - Entry Price) × Shares Sold`)
- **Percent PnL**: Percentage gain/loss (`(PnL ÷ Investment) × 100`)
- **Final Value**: Total value after closing (`Investment + PnL`)
- **ROI**: Return on Investment (same as Percent PnL)

### 📌 Status
- **Status**: Current position status (`open`, `closed`, `partially_closed`)
- **Days Held**: Number of days the position was open (`Exit Date - Entry Date`)

## Formulas

### Shares Bought (Entry)
```
=Simulated Investment / Entry Price
```

### Realized PnL (Exit)
```
=(Exit Price - Entry Price) × Shares Sold
```

### Percent PnL
```
=(Realized PnL / Simulated Investment) × 100
```

### Final Value
```
=Simulated Investment + Realized PnL
```

### Days Held
```
=IF(Exit Date <> "", Exit Date - Entry Date, "")
```

## Color Coding Suggestions

- **Green rows**: Profitable trades (Realized PnL > 0)
- **Red rows**: Losing trades (Realized PnL < 0)
- **Yellow rows**: Open positions (Status = "open")
- **Bold**: Important columns (Wallet Address, Market Name, Realized PnL, Percent PnL)

## Summary Statistics (Optional)

Add a summary section at the top:

| Metric | Value |
|--------|-------|
| Total Positions | 150 |
| Open Positions | 25 |
| Closed Positions | 125 |
| Total Invested | $62,500.00 |
| Total Realized PnL | $3,250.00 |
| Overall ROI | +5.20% |
| Win Rate | 68% |
| Average Hold Time | 2.5 days |
| Best Trade | +85.5% |
| Worst Trade | -99.88% |

