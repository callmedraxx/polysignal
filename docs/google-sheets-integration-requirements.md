# Google Sheets Integration Requirements

This document outlines what's needed to auto-create and auto-edit Google Sheets for copy trading positions.

## Prerequisites

### 1. Google Cloud Project Setup
- Create a Google Cloud Project
- Enable Google Sheets API
- Enable Google Drive API (for creating/managing spreadsheets)

### 2. Service Account
- Create a Service Account in Google Cloud Console
- Download the JSON key file
- Store the key file securely (e.g., in project root as `google-service-account.json`)
- **DO NOT** commit this file to git (add to `.gitignore`)

### 3. Environment Variables
Add to `.env`:
```env
# Enable/disable Google Sheets integration
GOOGLE_SHEETS_ENABLED=true

# Service account JSON file path
GOOGLE_SERVICE_ACCOUNT_PATH=./google-service-account.json

# Spreadsheet IDs (optional - will auto-create if not provided)
GOOGLE_SHEETS_FREE_SPREADSHEET_ID=  # Leave empty to auto-create
GOOGLE_SHEETS_PAID_SPREADSHEET_ID=  # Leave empty to auto-create

# Optional: Separate spreadsheets for aggregate/summary views
GOOGLE_SHEETS_FREE_AGGREGATE_SPREADSHEET_ID=  # Optional
GOOGLE_SHEETS_PAID_AGGREGATE_SPREADSHEET_ID=  # Optional

# Sheet names (configurable)
GOOGLE_SHEETS_MAIN_SHEET_NAME=CopyTrade Positions
GOOGLE_SHEETS_AGGREGATE_SHEET_NAME=Summary
```

### 4. NPM Packages
The `googleapis` package is already installed (includes `google-auth-library` as a dependency).
No additional installation needed.

## Google Sheets Structure

### Main Sheet: "CopyTrade Positions"
- **Sheet Name**: "CopyTrade Positions" (or configurable)
- **18 columns** as defined in `copytrade-spreadsheet-design.md`
- **Row 1**: Headers (frozen, bold, colored)
- **Row 2+**: Data rows

### Aggregate Sheets (Optional)
1. **Summary Sheet**
   - Total positions, open/closed counts
   - Total invested, total PnL, overall ROI
   - Win rate, average hold time
   - Best/worst trades

2. **Per-Wallet Summary**
   - Positions per wallet
   - Total PnL per wallet
   - ROI per wallet
   - Win rate per wallet

3. **Per-Market Summary**
   - Positions per market
   - Total volume per market
   - Average ROI per market

## Implementation Plan

### 1. Create Google Sheets Service
**File**: `src/services/google-sheets.service.ts`

Responsibilities:
- Initialize Google Sheets API client
- Create spreadsheet if it doesn't exist
- Create sheets (main + aggregate views)
- Append new rows (when BUY trade detected)
- Update existing rows (when position closed)
- Format cells (headers, colors, formulas)
- Refresh aggregate sheets

### 2. Integration Points

#### When BUY Trade Detected:
```typescript
// In trade-polling.service.ts
if (isCopytradeWallet || whale.isCopytrade) {
  // 1. Create CopyTradePosition in database
  // 2. Calculate shares bought
  // 3. Append row to Google Sheets
  await googleSheetsService.appendPosition({
    walletAddress,
    traderName: wallet.label,
    subscriptionType: wallet.subscriptionType,
    outcome: metadata.outcome,
    entryDate: activity.activityTimestamp,
    entryPrice: metadata.price,
    simulatedInvestment: wallet.simulatedInvestment,
    sharesBought: calculatedShares,
    status: 'open'
  });
}
```

#### When Position Closed:
```typescript
// In trade-polling.service.ts
if (position.status === 'closed') {
  // 1. Update CopyTradePosition in database
  // 2. Calculate P&L
  // 3. Find row in Google Sheets by position ID (stored in metadata)
  // 4. Update row with exit data
  await googleSheetsService.updatePosition(positionId, {
    exitDate: position.exitDate,
    exitPrice: position.exitPrice,
    sharesSold: position.sharesSold,
    realizedPnl: position.realizedPnl,
    percentPnl: position.percentPnl,
    finalValue: position.finalValue,
    status: 'closed'
  });
  
  // 5. Update aggregate sheets
  await googleSheetsService.refreshAggregateSheets();
}
```

### 3. Spreadsheet Creation

On first run or when spreadsheet doesn't exist:
1. Create new spreadsheet via Google Drive API
2. Create "CopyTrade Positions" sheet
3. Set up headers (Row 1) with formatting
4. Create aggregate sheets
5. Store spreadsheet ID in database/config

### 4. Row Management

**Finding Rows**: Store position ID in a hidden column or use a mapping table in database

**Appending**: Use `spreadsheets.values.append` API

**Updating**: Use `spreadsheets.values.update` API with row index

**Formulas**: Set formulas in columns I, M, N, O, P, R using `spreadsheets.values.update` with `valueInputOption: 'USER_ENTERED'`

### 5. Formatting

Apply formatting on creation:
- **Header Row (Row 1)**:
  - Bold text
  - Background color (e.g., #667eea)
  - White text
  - Frozen row
  - Text alignment: center
  
- **Data Rows**:
  - Conditional formatting:
    - Green background if PnL > 0
    - Red background if PnL < 0
    - Yellow background if status = "open"
  - Number formatting:
    - Currency for investment/PnL columns
    - Percentage for PnL/ROI columns
    - Date/Time for date columns
    - Decimal for prices/shares

## Required Files

### 1. Google Service Account Key
- **File**: `google-service-account.json` (in project root, NOT in git)
- **Content**: JSON key file from Google Cloud Console

### 2. Service Implementation
- **File**: `src/services/google-sheets.service.ts`
- **Methods**:
  - `initialize()` - Initialize Google API client
  - `createSpreadsheet()` - Create new spreadsheet
  - `ensureSheetsExist()` - Create required sheets
  - `appendPosition()` - Add new position row
  - `updatePosition()` - Update existing position row
  - `refreshAggregateSheets()` - Update summary sheets
  - `formatSheet()` - Apply formatting to sheets

### 3. Configuration
- Add to `.env`:
  ```env
  GOOGLE_SHEETS_ENABLED=true
  GOOGLE_SHEETS_SPREADSHEET_ID=
  GOOGLE_SERVICE_ACCOUNT_PATH=./google-service-account.json
  GOOGLE_SHEETS_MAIN_SHEET_NAME=CopyTrade Positions
  ```

### 4. Database Updates
- Add `googleSheetsRowIndex` to `CopyTradePosition` entity (optional, for faster row lookup)
- Store spreadsheet ID in config/metadata

## Step-by-Step Setup

1. **Create Google Cloud Project**
   - Go to https://console.cloud.google.com
   - Create new project
   - Enable Google Sheets API
   - Enable Google Drive API

2. **Create Service Account**
   - Go to IAM & Admin > Service Accounts
   - Create new service account
   - Grant roles: "Editor" (for creating/editing sheets)
   - Create key (JSON) and download

3. **Share Spreadsheet (if using existing)**
   - If spreadsheet already exists, share it with service account email
   - Service account email: `your-service-account@project-id.iam.gserviceaccount.com`

4. **Install Dependencies**
   ```bash
   npm install googleapis
   ```

5. **Add Environment Variables**
   - Add to `.env` file
   - Point to service account JSON file

6. **Initialize Service**
   - Service will auto-create spreadsheet on first run if not exists
   - Or provide existing spreadsheet ID in `.env`

## API Methods Reference

### Google Sheets API Methods Used:
- `spreadsheets.create` - Create new spreadsheet
- `spreadsheets.get` - Get spreadsheet info
- `spreadsheets.values.append` - Add new row
- `spreadsheets.values.update` - Update existing row
- `spreadsheets.values.get` - Read data
- `spreadsheets.batchUpdate` - Batch operations (formatting, etc.)

## Error Handling

- Handle API rate limits (use exponential backoff)
- Handle authentication errors
- Log all operations
- Retry failed operations
- Store failed operations for manual sync

## Testing

1. Test with single position (BUY)
2. Test position closure (SELL)
3. Test multiple positions
4. Test aggregate sheet updates
5. Test error scenarios (API failures, etc.)

