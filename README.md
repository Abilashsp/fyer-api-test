# Fyers Trading API Integration

A comprehensive Node.js application for interacting with the Fyers Trading API, featuring real-time market data, automated trading strategies, and efficient data management.

## Features

- 🔐 Secure authentication with Fyers API
- 📊 Real-time market data streaming
- 📈 Automated trading strategies
- 💾 Efficient data caching with SQLite
- ⚡ Optimized entry time calculations
- 🔄 Resolution-based data management
- 📱 WebSocket support for real-time updates
- 🎯 Bullish signal detection
- 📅 Daily data cleanup and management

## Prerequisites

- Node.js (v14 or higher)
- npm or yarn
- Fyers Trading Account
- API credentials from Fyers

## Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/fyers-api.git
cd fyers-api
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the root directory:
```env
FYERS_CLIENT_ID=your_client_id
FYERS_SECRET_KEY=your_secret_key
FYERS_REDIRECT_URI=http://localhost:4000
PORT=4000
```

## Project Structure

```
fyers-api/
├── src/
│   ├── services/
│   │   ├── entryTimeService.js    # Entry time management
│   │   └── sqliteService.js       # SQLite database service
│   ├── components/
│   │   ├── StockFeed.jsx         # Real-time stock feed
│   │   └── BullishStocks.jsx     # Bullish signals display
│   ├── server.js                 # Express server
│   ├── strategy.js               # Trading strategy
│   ├── dataSocket.js            # Market data socket
│   ├── tradingService.js        # Trading operations
│   └── auth2.0.js               # Authentication
├── data/
│   └── history_cache.db         # SQLite database
├── logs/                        # Application logs
└── package.json
```

## API Endpoints

### Authentication
- `GET /` - Fyers authentication callback
- `GET /api/health` - Health check endpoint

### Market Data
- `GET /api/entrytimes` - Get entry times for symbols
  - Query Parameters:
    - `symbols` (optional): Comma-separated list of symbols
    - `resolution` (optional): Timeframe (1, 5, 15, 30, 60, 240, D)

### Trading Signals
- `GET /api/bullish-signals` - Get current bullish signals
- `GET /api/strategy/signals` - Get strategy signals
  - Query Parameters:
    - `symbols` (optional): Comma-separated list of symbols
    - `resolution` (optional): Timeframe

## Entry Time System

The entry time system provides efficient management of trading entry points:

### Features
- Resolution-based entry time calculation
- Daily data cleanup
- Market hours awareness
- Multiple timeframe support

### Supported Resolutions
- 1 minute (1)
- 5 minutes (5)
- 15 minutes (15)
- 30 minutes (30)
- 1 hour (60)
- 4 hours (240)
- Daily (D)

### Example Response
```javascript
{
  "success": true,
  "resolution": "240",
  "entryTimes": [
    {
      "symbol": "NSE:RELIANCE-EQ",
      "candleStartTimes": ["09:15:00", "13:15:00"],
      "lastEntryTime": "2024-04-23 09:15:00"
    }
  ]
}
```

## WebSocket Events

### Client Events
- `connect` - Connection established
- `disconnect` - Connection closed
- `message` - Real-time market data
- `bullishSignals` - Bullish signal updates

## Development

1. Start the development server:
```bash
npm start
```

2. Access the application:
- Frontend: http://localhost:3000
- Backend: http://localhost:4000

## Data Management

### SQLite Database
- Stores historical data
- Manages entry times
- Handles resolution-specific data
- Daily cleanup and updates

### Caching System
- In-memory cache for real-time data
- SQLite cache for historical data
- Resolution-based caching
- Automatic cache invalidation

## Error Handling

The application includes comprehensive error handling:
- API rate limiting
- Connection retries
- Data validation
- Error logging

## Logging

Logs are stored in the `logs` directory:
- Daily log files
- Error tracking
- Performance monitoring
- Debug information

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

For support, please:
1. Check the documentation
2. Open an issue
3. Contact the maintainers

## Acknowledgments

- Fyers API documentation
- Node.js community
- Contributors and maintainers 