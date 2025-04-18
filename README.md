# Fyers Trading API

A comprehensive Node.js application for interacting with the Fyers Trading API. This application provides a REST API and WebSocket connections for real-time trading data.

## Features

- **Automatic Authentication**: Handles authentication and token refresh automatically
- **Comprehensive Trading API**: Supports all Fyers API functionalities
- **REST API Endpoints**: Easy-to-use REST API for all trading operations
- **WebSocket Support**: Real-time data streaming for orders, trades, positions, and market data
- **Error Handling**: Robust error handling and automatic retry mechanisms

## Prerequisites

- Node.js (v14 or higher)
- Fyers API credentials (App ID, Secret Key, Redirect URI)

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd fyers-api
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file with your Fyers API credentials:
```bash
cp .env.example .env
# Edit .env with your credentials
```

4. Start the server:
```bash
node src/server.js
```

## Authentication

The first time you run the application, it will prompt you to authenticate with Fyers. Follow these steps:

1. When prompted, visit the provided URL in your browser
2. Log in to your Fyers account and authorize the application
3. Copy the auth code from the redirect URL
4. Enter the auth code in the terminal when prompted

The application will save the access token for future use, so you won't need to authenticate again unless the token expires.

## WebSocket Connections

The application automatically extracts the HSM key from your access token for WebSocket connections. No additional configuration is needed.

If WebSocket connections fail, the application will continue to function with REST API endpoints. The application includes robust error handling to ensure it remains operational even if WebSocket connections cannot be established.

## API Endpoints

### Profile and Account Info
- `GET /api/profile` - Get user profile
- `GET /api/funds` - Get account funds

### Market Data
- `GET /api/history` - Get historical data
  - Query parameters: `symbol`, `resolution`, `fromDate`, `toDate`
- `GET /api/quotes` - Get real-time quotes
  - Query parameters: `symbols`

### Order Management
- `POST /api/orders` - Place an order
- `DELETE /api/orders/:orderId` - Cancel an order
- `PUT /api/orders/:orderId` - Modify an order

### Position and Holdings
- `GET /api/positions` - Get positions
- `GET /api/holdings` - Get holdings

### Order Book and Trade Book
- `GET /api/orderbook` - Get order book
- `GET /api/tradebook` - Get trade book

### GTT Orders
- `POST /api/gtt` - Place a GTT order
- `PUT /api/gtt/:gttId` - Modify a GTT order
- `DELETE /api/gtt/:gttId` - Cancel a GTT order

## WebSocket Events

The application provides WebSocket connections for real-time data:

- `orders` - Real-time order updates
- `trades` - Real-time trade updates
- `positions` - Real-time position updates
- `ticks` - Real-time market data ticks
- `ohlc` - Real-time OHLC data

## Example Usage

### Place an Order

```javascript
// Using fetch API
fetch('http://localhost:4000/api/orders', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    symbol: 'NSE:SBIN-EQ',
    quantity: 1,
    type: 1, // 1 for Market, 2 for Limit
    side: 1, // 1 for Buy, -1 for Sell
    productType: 'INTRADAY',
    limitPrice: 0,
    stopPrice: 0,
    validity: 'DAY',
    disclosedQty: 0,
    offlineOrder: false
  })
})
.then(response => response.json())
.then(data => console.log(data))
.catch(error => console.error('Error:', error));
```

### Get Historical Data

```javascript
// Using fetch API
fetch('http://localhost:4000/api/history?symbol=NSE:SBIN-EQ&resolution=D&fromDate=2023-01-01&toDate=2023-12-31')
.then(response => response.json())
.then(data => console.log(data))
.catch(error => console.error('Error:', error));
```

## Error Handling

The application includes robust error handling for all API calls and WebSocket connections. If a WebSocket connection fails, the application will continue to run and provide REST API functionality.

## License

MIT 