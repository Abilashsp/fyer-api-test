const { fyersModel } = require('fyers-api-v3');
const authManager = require('./auth2.0');
const { extractHsmKeyFromToken } = require('./utils');
const { EventEmitter } = require('events');
const orderSocket = require('./orderSocket');
const dataSocket = require('./dataSocket');

class TradingService {
  constructor() {
    this.fyers = null;
    this.orderSocket = null;
    this.dataSocket = null;
    this.hsmKey = null;
  }

  async initialize() {
    try {
      // Initialize Fyers instance
      this.fyers = await authManager.initialize();
      
      return this;
    } catch (error) {
      console.error('Error initializing trading service:', error);
      throw error;
    }
  }

  // Market Data Methods
  async getHistoricalData(symbol, resolution = 'D', fromDate, toDate) {
    try {
      // Convert dates to epoch timestamps if they're not already
      const fromEpoch = fromDate ? new Date(fromDate).getTime() / 1000 : undefined;
      const toEpoch = toDate ? new Date(toDate).getTime() / 1000 : undefined;
      
      const params = {
        symbol,
        resolution,
        date_format: '0', // 0 for epoch timestamps
        range_from: fromEpoch,
        range_to: toEpoch,
        cont_flag: '1'
      };
      console.log("Requesting Fyers History:", params);
      
      const response = await this.fyers.getHistory(params);
      
      // Check if the response is valid
      if (response && response.s === 'ok' && response.candles) {
        return {
          success: true,
          candles: response.candles.map(candle => ({
            timestamp: candle[0],  // Epoch timestamp
            open: candle[1],       // Opening price
            high: candle[2],       // Highest price
            low: candle[3],        // Lowest price
            close: candle[4],      // Closing price
            volume: candle[5]      // Trading volume
          }))
        };
      } else {
        throw new Error('Invalid response format from Fyers API');
      }
    } catch (error) {
      console.error('Error fetching historical data:', error);
      throw error;
    }
  }

  async getQuotes(symbols) {
    try {
      // Make sure symbols is an array
      const symbolsArray = Array.isArray(symbols) ? symbols : [symbols];
      return await this.fyers.getQuotes({ symbols: symbolsArray });
    } catch (error) {
      console.error('Error fetching quotes:', error);
      throw error;
    }
  }

  // Order Management Methods
  async placeOrder(orderParams) {
    try {
      const order = {
        symbol: orderParams.symbol,
        qty: orderParams.quantity,
        type: orderParams.type || 1, // 1 for Market, 2 for Limit
        side: orderParams.side, // 1 for Buy, -1 for Sell
        productType: orderParams.productType || 'INTRADAY',
        limitPrice: orderParams.limitPrice || 0,
        stopPrice: orderParams.stopPrice || 0,
        validity: orderParams.validity || 'DAY',
        disclosedQty: orderParams.disclosedQty || 0,
        offlineOrder: orderParams.offlineOrder || false,
      };
      return await this.fyers.placeOrder(order);
    } catch (error) {
      console.error('Error placing order:', error);
      throw error;
    }
  }

  async cancelOrder(orderId) {
    try {
      return await this.fyers.cancelOrder({ id: orderId });
    } catch (error) {
      console.error('Error canceling order:', error);
      throw error;
    }
  }

  async modifyOrder(orderId, orderParams) {
    try {
      const order = {
        id: orderId,
        ...orderParams
      };
      return await this.fyers.modifyOrder(order);
    } catch (error) {
      console.error('Error modifying order:', error);
      throw error;
    }
  }

  // Position Management
  async getPositions() {
    try {
      const response = await this.fyers.get_positions();
      
      // Check if the response is valid
      if (response && response.s === 'ok' && response.netPositions) {
        return {
          success: true,
          overall: {
            countTotal: response.overall.count_total,
            countOpen: response.overall.count_open,
            plTotal: response.overall.pl_total,
            plRealized: response.overall.pl_realized,
            plUnrealized: response.overall.pl_unrealized
          },
          positions: response.netPositions.map(position => ({
            netQty: position.netQty,
            qty: position.qty,
            avgPrice: position.avgPrice,
            netAvg: position.netAvg,
            side: position.side,
            productType: position.productType,
            realizedProfit: position.realized_profit,
            unrealizedProfit: position.unrealized_profit,
            pl: position.pl,
            ltp: position.ltp,
            buyQty: position.buyQty,
            buyAvg: position.buyAvg,
            buyVal: position.buyVal,
            sellQty: position.sellQty,
            sellAvg: position.sellAvg,
            sellVal: position.sellVal,
            slNo: position.slNo,
            fyToken: position.fyToken,
            crossCurrency: position.crossCurrency,
            rbiRefRate: position.rbiRefRate,
            qtyMultiCom: position.qtyMulti_com,
            segment: position.segment,
            symbol: position.symbol,
            id: position.id,
            cfBuyQty: position.cfBuyQty,
            cfSellQty: position.cfSellQty,
            dayBuyQty: position.dayBuyQty,
            daySellQty: position.daySellQty,
            exchange: position.exchange
          }))
        };
      } else {
        throw new Error('Invalid response format from Fyers API');
      }
    } catch (error) {
      console.error('Error fetching positions:', error);
      throw error;
    }
  }

  async getHoldings() {
    try {
      const response = await this.fyers.get_holdings();
      
      // Check if the response is valid
      if (response && response.s === 'ok' && response.holdings) {
        return {
          success: true,
          overall: {
            countTotal: response.overall.count_total,
            pnlPercentage: response.overall.pnl_perc,
            totalCurrentValue: response.overall.total_current_value,
            totalInvestment: response.overall.total_investment,
            totalPL: response.overall.total_pl
          },
          holdings: response.holdings.map(holding => ({
            costPrice: holding.costPrice,
            id: holding.id,
            fyToken: holding.fyToken,
            symbol: holding.symbol,
            isin: holding.isin,
            quantity: holding.quantity,
            exchange: holding.exchange,
            segment: holding.segment,
            qtyT1: holding.qty_t1,
            remainingQuantity: holding.remainingQuantity,
            collateralQuantity: holding.collateralQuantity,
            remainingPledgeQuantity: holding.remainingPledgeQuantity,
            pl: holding.pl,
            ltp: holding.ltp,
            marketVal: holding.marketVal,
            holdingType: holding.holdingType
          }))
        };
      } else {
        throw new Error('Invalid response format from Fyers API');
      }
    } catch (error) {
      console.error('Error fetching holdings:', error);
      throw error;
    }
  }

  // Order Book and Trade Book
  async getOrderBook() {
    try {
      // In Fyers API v3, the method is get_orders instead of get_orderbook
      const response = await this.fyers.get_orders();
      
      // Check if the response is valid
      if (response && response.s === 'ok' && response.orderBook) {
        return {
          success: true,
          orders: response.orderBook.map(order => ({
            clientId: order.clientId,
            id: order.id,
            exchOrdId: order.exchOrdId,
            qty: order.qty,
            remainingQuantity: order.remainingQuantity,
            filledQty: order.filledQty,
            discloseQty: order.discloseQty,
            limitPrice: order.limitPrice,
            stopPrice: order.stopPrice,
            tradedPrice: order.tradedPrice,
            type: order.type,
            fyToken: order.fyToken,
            exchange: order.exchange,
            segment: order.segment,
            symbol: order.symbol,
            instrument: order.instrument,
            message: order.message,
            offlineOrder: order.offlineOrder,
            orderDateTime: order.orderDateTime,
            orderValidity: order.orderValidity,
            pan: order.pan,
            productType: order.productType,
            side: order.side,
            status: order.status,
            source: order.source,
            exSym: order.ex_sym,
            description: order.description,
            change: order.ch,
            changePercentage: order.chp,
            lastPrice: order.lp,
            slNo: order.slNo,
            dqQtyRem: order.dqQtyRem,
            orderNumStatus: order.orderNumStatus,
            disclosedQty: order.disclosedQty,
            orderTag: order.orderTag
          }))
        };
      } else {
        throw new Error('Invalid response format from Fyers API');
      }
    } catch (error) {
      console.error('Error fetching order book:', error);
      throw error;
    }
  }

  async getTradeBook() {
    try {
      // In Fyers API v3, the method is get_tradebook instead of getTradeBook
      const response = await this.fyers.get_tradebook();
      
      // Check if the response is valid
      if (response && response.s === 'ok' && response.tradeBook) {
        return {
          success: true,
          trades: response.tradeBook.map(trade => ({
            clientId: trade.clientId,
            orderDateTime: trade.orderDateTime,
            orderNumber: trade.orderNumber,
            exchangeOrderNo: trade.exchangeOrderNo,
            exchange: trade.exchange,
            side: trade.side,
            segment: trade.segment,
            orderType: trade.orderType,
            fyToken: trade.fyToken,
            productType: trade.productType,
            tradedQty: trade.tradedQty,
            tradePrice: trade.tradePrice,
            tradeValue: trade.tradeValue,
            tradeNumber: trade.tradeNumber,
            row: trade.row,
            symbol: trade.symbol,
            orderTag: trade.orderTag
          }))
        };
      } else {
        throw new Error('Invalid response format from Fyers API');
      }
    } catch (error) {
      console.error('Error fetching trade book:', error);
      throw error;
    }
  }

  // Fund Management
  async getFunds() {
    try {
      // In Fyers API v3, the method is get_funds instead of getFunds
      const response = await this.fyers.get_funds();
      
      // Check if the response is valid
      if (response && response.s === 'ok' && response.fund_limit) {
        return {
          success: true,
          data: response.fund_limit.map(fund => ({
            id: fund.id,
            title: fund.title,
            equityAmount: fund.equityAmount,
            commodityAmount: fund.commodityAmount
          }))
        };
      } else {
        throw new Error('Invalid response format from Fyers API');
      }
    } catch (error) {
      console.error('Error fetching funds:', error);
      throw error;
    }
  }

  // Profile and Account Info
  async getProfile() {
    try {
      return await this.fyers.get_profile();
    } catch (error) {
      console.error('Error fetching profile:', error);
      throw error;
    }
  }

  // GTT (Good Till Triggered) Orders
  async placeGTTOrder(gttParams) {
    try {
      return await this.fyers.placeGTT(gttParams);
    } catch (error) {
      console.error('Error placing GTT order:', error);
      throw error;
    }
  }

  async modifyGTTOrder(gttId, gttParams) {
    try {
      return await this.fyers.modifyGTT(gttParams);
    } catch (error) {
      console.error('Error modifying GTT order:', error);
      throw error;
    }
  }

  async cancelGTTOrder(gttId) {
    try {
      return await this.fyers.cancelGTT({ id: gttId });
    } catch (error) {
      console.error('Error canceling GTT order:', error);
      throw error;
    }
  }

  // WebSocket Methods
  async connectOrderSocket(socketToken) {
    try {
      if (!this.fyers) {
        console.warn('⚠️ Cannot connect to order socket: Fyers instance not available');
        return new EventEmitter();
      }

      // Use the socketToken directly instead of extracting HSM key
      this.orderSocket = await orderSocket.connect(this.fyers, socketToken);
      return this.orderSocket;
    } catch (error) {
      console.error('❌ Error connecting to order socket:', error);
      return new EventEmitter();
    }
  }

  async connectDataSocket(socketToken) {
    try {
      if (!this.fyers) {
        console.warn('⚠️ Cannot connect to data socket: Fyers instance not available');
        return new EventEmitter();
      }

      // Use the socketToken directly instead of extracting HSM key
      this.dataSocket = await dataSocket.connect(this.fyers, socketToken);
      return this.dataSocket;
    } catch (error) {
      console.error('❌ Error connecting to data socket:', error);
      return new EventEmitter();
    }
  }
}

module.exports = new TradingService(); 