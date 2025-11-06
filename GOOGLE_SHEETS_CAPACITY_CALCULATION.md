# Google Sheets API Capacity Calculation for Copy Trading

## Assumptions
- **Trade frequency**: Every 10 seconds per trader
- **Google Sheets API limit**: 60 write requests per minute per user (per Google's documented limits)
- **Batching system**: Current implementation uses batching with:
  - `BATCH_SIZE = 10` (flush when queue reaches 10 positions)
  - `BATCH_TIMEOUT_MS = 5000` (flush every 5 seconds)

## API Calls Per Trade

### Operations in `flushAllBatches()`:

For each batch of trades (grouped by spreadsheet + sheet):

1. **Append rows** (batched): 1 write API call
2. **Get sheet ID**: 1 read API call (not counted in write limit)
3. **Batch update formulas** (6 formulas per row): 1 write API call
4. **Conditional formatting**: 1 write API call per position (3 rules per position)

### Per Trade API Calls (worst case - single trade per batch):

When trades come in every 10 seconds and batch timeout is 5 seconds, each trade typically flushes individually:
- **Append row**: 1 write
- **Update formulas**: 1 write  
- **Apply formatting**: 1 write
- **Total per trade**: **3 write API calls**

### Per Trade API Calls (best case - full batch of 10):

When multiple trades are batched together:
- **Append rows (10 rows)**: 1 write
- **Update formulas (10 rows)**: 1 write
- **Apply formatting (10 rows)**: 10 writes (one per row)
- **Total for 10 trades**: 12 writes = **1.2 writes per trade**

## Capacity Calculation

### Scenario 1: Worst Case (Trades Flush Individually)

**Per trader per minute:**
- 6 trades per minute (every 10 seconds)
- 3 writes per trade
- **Total: 18 writes per minute per trader**

**Maximum number of traders:**
- 60 writes per minute available
- 18 writes per trader per minute
- **Capacity: 60 ÷ 18 = ~3.3 traders**

**Conservative estimate: ~3 unique traders**

### Scenario 2: Best Case (Perfect Batching)

**Per trader per minute:**
- 6 trades per minute
- 1.2 writes per trade (when batched in groups of 10)
- **Total: 7.2 writes per minute per trader**

**Maximum number of traders:**
- 60 writes per minute available
- 7.2 writes per trader per minute
- **Capacity: 60 ÷ 7.2 = ~8.3 traders**

**Optimistic estimate: ~8 unique traders**

### Scenario 3: Realistic Case (Mixed Batching)

In practice, with trades coming every 10 seconds:
- Some trades will batch together (if multiple traders trade simultaneously)
- Most trades will flush individually (due to 5-second timeout)
- Average: ~2 writes per trade

**Per trader per minute:**
- 6 trades per minute
- 2 writes per trade (average)
- **Total: 12 writes per minute per trader**

**Maximum number of traders:**
- 60 writes per minute available
- 12 writes per trader per minute
- **Capacity: 60 ÷ 12 = 5 traders**

**Realistic estimate: ~4-5 unique traders**

## Key Bottlenecks

1. **Conditional formatting**: Currently applies 1 write API call per row. This is the main bottleneck.
2. **Batch timeout**: 5-second timeout means trades every 10 seconds will often flush individually.

## Optimization Recommendations

1. **Batch conditional formatting**: Instead of one API call per row, batch all formatting rules for multiple rows into a single `batchUpdate` call.

2. **Increase batch timeout**: Consider increasing `BATCH_TIMEOUT_MS` to 8-9 seconds to better align with 10-second trade intervals.

3. **Lazy formatting**: Apply conditional formatting rules once per sheet instead of per row, using range-based rules.

4. **Skip formatting on append**: Consider applying formatting only when trades are closed/finalized, not on every trade entry.

## Final Estimate

**Conservative (worst case)**: **~3 unique traders**  
**Realistic (mixed batching)**: **~4-5 unique traders**  
**Optimistic (perfect batching)**: **~8 unique traders**

**Recommended capacity planning**: **~4 unique traders** to stay safely within limits with buffer for spikes.

