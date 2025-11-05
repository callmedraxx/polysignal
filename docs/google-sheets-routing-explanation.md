# Google Sheets Routing & Existing Spreadsheet Support

## How the System Routes to Correct Spreadsheet

The system automatically routes copytrade positions to the correct Google Sheet based on the **subscription type** of the copytrade wallet.

### Routing Logic

1. **When a new copytrade position is created:**
   - System reads the `subscriptionType` from the `CopyTradeWallet` or `TrackedWhale`
   - Routes to:
     - **Free signals** → `GOOGLE_SHEETS_FREE_SPREADSHEET_ID`
     - **Paid signals** → `GOOGLE_SHEETS_PAID_SPREADSHEET_ID`

2. **When updating an existing position:**
   - System looks up the position in the database
   - Gets the `subscriptionType` from the associated wallet
   - Routes to the same spreadsheet where the position was originally added

### Code Flow

```typescript
// In appendPosition()
const spreadsheetId = this.getSpreadsheetId(data.subscriptionType);
// Returns freeSpreadsheetId or paidSpreadsheetId based on subscriptionType

// In updatePosition()
const position = await findPosition(positionId);
const subscriptionType = position.copyTradeWallet.subscriptionType;
const spreadsheetId = this.getSpreadsheetId(subscriptionType);
```

## Support for Existing Spreadsheets

### ✅ Yes, the system can track and update existing spreadsheets!

The system supports three scenarios:

### Scenario 1: Auto-Created Spreadsheets
- If `GOOGLE_SHEETS_FREE_SPREADSHEET_ID` or `GOOGLE_SHEETS_PAID_SPREADSHEET_ID` are **not set** in `.env`
- System automatically creates new spreadsheets on startup
- Spreadsheet IDs are logged to console
- You can copy these IDs to `.env` for persistence

### Scenario 2: Manually Created Spreadsheets
- If you create spreadsheets manually in Google Sheets
- Copy the spreadsheet ID from the URL:
  ```
  https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/edit
  ```
- Add to `.env`:
  ```env
  GOOGLE_SHEETS_FREE_SPREADSHEET_ID=your-free-spreadsheet-id
  GOOGLE_SHEETS_PAID_SPREADSHEET_ID=your-paid-spreadsheet-id
  ```
- **Important:** Share the spreadsheet with your service account email:
  - Service account email: `your-service-account@project-id.iam.gserviceaccount.com`
  - Permission: **Editor**

### Scenario 3: Mixed (Some Auto, Some Manual)
- You can have one auto-created and one manual
- Example:
  ```env
  GOOGLE_SHEETS_FREE_SPREADSHEET_ID=  # Leave empty = auto-create
  GOOGLE_SHEETS_PAID_SPREADSHEET_ID=abc123xyz  # Manual spreadsheet
  ```

## Verification & Error Handling

### On Startup
The system verifies spreadsheets exist and are accessible:

1. **If spreadsheet ID is provided:**
   - Verifies spreadsheet exists and is accessible
   - Checks if main sheet "CopyTrade Positions" exists
   - Creates the sheet if it doesn't exist (but spreadsheet does)
   - Logs success or error messages

2. **If spreadsheet ID is not provided:**
   - Creates new spreadsheet automatically
   - Sets up main sheet with headers and formatting
   - Logs the new spreadsheet ID

### On Position Append/Update
Before appending or updating:

1. **Verifies spreadsheet is accessible:**
   - Checks if spreadsheet exists
   - Verifies service account has access
   - Logs error if spreadsheet not found

2. **Routes to correct spreadsheet:**
   - Uses `subscriptionType` to determine which spreadsheet
   - Throws clear error if spreadsheet ID not configured

## Example Flow

### Example 1: Free Subscription Wallet
```
1. User adds copytrade wallet with subscriptionType = "free"
2. Trade detected → Position created
3. System calls: appendPosition({ subscriptionType: "free", ... })
4. getSpreadsheetId("free") returns: GOOGLE_SHEETS_FREE_SPREADSHEET_ID
5. Position appended to Free Signals Spreadsheet
```

### Example 2: Paid Subscription Whale
```
1. User adds tracked whale to copytrade with subscriptionType = "paid"
2. Trade detected → Position created
3. System calls: appendPosition({ subscriptionType: "paid", ... })
4. getSpreadsheetId("paid") returns: GOOGLE_SHEETS_PAID_SPREADSHEET_ID
5. Position appended to Paid Signals Spreadsheet
```

### Example 3: Position Update
```
1. Position closes → updatePosition() called
2. System looks up position in database
3. Gets subscriptionType from position.copyTradeWallet.subscriptionType
4. Routes to same spreadsheet where position was originally added
5. Finds row by wallet address + entry date
6. Updates exit data, PnL, etc.
```

## Troubleshooting

### Error: "Spreadsheet not found"
**Cause:** Spreadsheet ID is incorrect or spreadsheet not shared with service account

**Solution:**
1. Verify spreadsheet ID in `.env` matches the ID in the URL
2. Share spreadsheet with service account email (Editor permission)
3. Check service account email in Google Cloud Console

### Error: "No spreadsheet ID configured"
**Cause:** Spreadsheet ID not set in `.env` and system hasn't auto-created it yet

**Solution:**
1. Either set the ID in `.env`, or
2. Let the system auto-create it (leave empty in `.env`)

### Error: "Sheet not found"
**Cause:** Spreadsheet exists but main sheet doesn't exist

**Solution:**
- System will automatically create the sheet "CopyTrade Positions" if it doesn't exist
- Or manually create a sheet with that exact name

## Best Practices

1. **Set spreadsheet IDs in `.env`** for production:
   - Prevents auto-creation on every restart
   - Ensures consistent spreadsheet usage
   - Makes it easier to manage

2. **Share spreadsheets with service account:**
   - Always share with Editor permission
   - Service account email is in your Google Cloud Console

3. **Use separate spreadsheets for free/paid:**
   - Keeps data organized
   - Easier to manage permissions
   - Better for analytics

4. **Monitor logs on startup:**
   - Check for spreadsheet verification messages
   - Verify spreadsheet IDs are correct
   - Ensure sheets are accessible

## Summary

✅ **Yes, the system can track and update existing spreadsheets!**

- Routes positions to correct spreadsheet based on `subscriptionType`
- Verifies spreadsheets exist and are accessible
- Creates missing sheets in existing spreadsheets
- Handles both auto-created and manually created spreadsheets
- Provides clear error messages if spreadsheets are not accessible

The system is designed to work seamlessly with existing spreadsheets as long as:
1. Spreadsheet IDs are correctly set in `.env`
2. Spreadsheets are shared with the service account
3. Service account has Editor permission

