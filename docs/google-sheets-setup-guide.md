# Google Sheets Setup Guide

## Quick Setup

### 1. Google Cloud Console Setup

1. Go to https://console.cloud.google.com
2. Create a new project (or select existing)
3. Enable APIs:
   - **Google Sheets API**
   - **Google Drive API**
4. Create Service Account:
   - Go to **IAM & Admin** > **Service Accounts**
   - Click **Create Service Account**
   - Name: `polysignal-sheets`
   - Grant role: **Editor** (or create custom role with Sheets/Drive permissions)
   - Click **Create Key** > **JSON**
   - Download the JSON file

**📖 For detailed step-by-step instructions, see: [google-service-account-setup.md](./google-service-account-setup.md)**

### 2. Save Service Account Key

1. Save the downloaded JSON file as `google-service-account.json` in your project root (`/root/polysignal/`)
2. The file is automatically ignored by git (already in `.gitignore`)
3. Verify file location:
   ```bash
   ls -la /root/polysignal/google-service-account.json
   ```

### 3. Configure Environment Variables

Add to your `.env` file:

```env
# Enable Google Sheets integration
GOOGLE_SHEETS_ENABLED=true

# Path to service account JSON file
GOOGLE_SERVICE_ACCOUNT_PATH=./google-service-account.json

# Spreadsheet IDs (optional - will auto-create if not provided)
# Leave empty to auto-create, or provide existing spreadsheet IDs
GOOGLE_SHEETS_FREE_SPREADSHEET_ID=
GOOGLE_SHEETS_PAID_SPREADSHEET_ID=

# Optional: Separate spreadsheets for aggregate/summary views
GOOGLE_SHEETS_FREE_AGGREGATE_SPREADSHEET_ID=
GOOGLE_SHEETS_PAID_AGGREGATE_SPREADSHEET_ID=

# Sheet names (configurable)
GOOGLE_SHEETS_MAIN_SHEET_NAME=CopyTrade Positions
GOOGLE_SHEETS_AGGREGATE_SHEET_NAME=Summary
```

### 4. Auto-Creation vs Manual Setup

#### Option A: Auto-Create (Recommended for first time)
- Leave `GOOGLE_SHEETS_FREE_SPREADSHEET_ID` and `GOOGLE_SHEETS_PAID_SPREADSHEET_ID` empty
- The system will automatically create two spreadsheets:
  - "PolySignal CopyTrade - Free Signals"
  - "PolySignal CopyTrade - Paid Signals"
- Spreadsheet IDs will be logged to console on startup

#### Option B: Use Existing Spreadsheets
- Create spreadsheets manually in Google Sheets
- Copy the spreadsheet ID from the URL:
  - URL format: `https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/edit`
- Paste the IDs into `.env`:
  ```env
  GOOGLE_SHEETS_FREE_SPREADSHEET_ID=your-free-spreadsheet-id-here
  GOOGLE_SHEETS_PAID_SPREADSHEET_ID=your-paid-spreadsheet-id-here
  ```
- Share the spreadsheets with your service account email:
  - Service account email: `polysignal-sheets@your-project-id.iam.gserviceaccount.com`
  - Permission: **Editor**

### 5. Verify Setup

1. Start your application
2. Check console logs for:
   - `✅ Google Sheets service initialized`
   - Spreadsheet creation messages (if auto-creating)
3. Check Google Drive for newly created spreadsheets (if auto-created)

## How It Works

### Spreadsheet Routing

Positions are automatically routed to the correct spreadsheet based on `subscriptionType`:

- **Free signals** → `GOOGLE_SHEETS_FREE_SPREADSHEET_ID`
- **Paid signals** → `GOOGLE_SHEETS_PAID_SPREADSHEET_ID`

### Auto-Creation Flow

1. On startup, service checks if spreadsheet IDs are provided
2. If not provided:
   - Creates "PolySignal CopyTrade - Free Signals" spreadsheet
   - Creates "PolySignal CopyTrade - Paid Signals" spreadsheet
   - Sets up main sheet with headers and formatting
   - Logs spreadsheet IDs to console
3. If provided:
   - Verifies spreadsheets exist
   - Ensures main sheet exists (creates if missing)

### When Positions Are Added

1. **BUY Trade Detected**:
   - Creates `CopyTradePosition` in database
   - Calculates shares bought
   - Appends row to appropriate spreadsheet (free/paid)
   - Sets up formulas for calculated columns

2. **Position Closed**:
   - Updates `CopyTradePosition` in database
   - Finds row in spreadsheet (by wallet + entry date)
   - Updates exit data and P&L calculations
   - Formulas auto-update

## Troubleshooting

### Service Account Not Working
- Verify JSON file path is correct
- Check file permissions (readable)
- Verify service account has Editor role

### Spreadsheet Not Found
- Check spreadsheet ID is correct
- Verify spreadsheet is shared with service account email
- Check service account email in Google Cloud Console

### Auto-Creation Fails
- Verify Google Drive API is enabled
- Check service account has Editor role
- Review console logs for specific error messages

### Formulas Not Working
- Formulas are set using `USER_ENTERED` mode
- Google Sheets will auto-calculate when data is entered
- Manual refresh may be needed in some cases

## Spreadsheet Structure

### Main Sheet Columns (18 total)

| Col | Name | Formula |
|-----|------|---------|
| A | Wallet Address | - |
| B | Trader Name | - |
| C | Subscription Type | - |
| D | Outcome Chosen | - |
| E | Realized Outcome | - |
| F | Entry Date/Time | - |
| G | Entry Price | - |
| H | Simulated Investment | - |
| I | Shares Bought | `=H2/G2` |
| J | Exit Date | - |
| K | Exit Price | - |
| L | Shares Sold | - |
| M | Realized PnL | `=(K2-G2)*L2` |
| N | Percent PnL | `=(M2/H2)*100` |
| O | Final Value | `=H2+M2` |
| P | ROI | `=N2` |
| Q | Status | - |
| R | Hours Held | `=(J2-F2)*24` |

### Formatting

- **Header Row**: Blue background, white text, bold, frozen
- **Green rows**: Profitable trades (PnL > 0)
- **Red rows**: Losing trades (PnL < 0)
- **Yellow rows**: Open positions

## Next Steps

After setup:
1. Add copytrade wallets via admin panel
2. Positions will automatically appear in spreadsheets
3. Monitor in real-time as trades are detected
4. View aggregate statistics in separate sheets (if configured)

