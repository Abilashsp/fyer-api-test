"use client";
import React, { useEffect, useState } from "react";
import io from "socket.io-client";

// Create socket connection
const socket = io("http://localhost:4000", {
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
});

// Resolution options
const RESOLUTIONS = {
  MINUTE_1: { value: "1", label: "1 Minute" },
  MINUTE_5: { value: "5", label: "5 Minutes" },
  MINUTE_15: { value: "15", label: "15 Minutes" },
  MINUTE_30: { value: "30", label: "30 Minutes" },
  HOUR_1: { value: "60", label: "1 Hour" },
  HOUR_4: { value: "240", label: "4 Hours" },
  DAY_1: { value: "D", label: "1 Day" }
};

export default function StockFeed() {
  const [latestStocks, setLatestStocks] = useState({});
  const [bullishSignals, setBullishSignals] = useState([]);
  const [connectionStatus, setConnectionStatus] = useState("disconnected");
  const [error, setError] = useState(null);
  const [resolution, setResolution] = useState("240"); // Default to 4-hour candles
  const [isChangingResolution, setIsChangingResolution] = useState(false);

  useEffect(() => {
    // Connection events
    socket.on("connect", () => {
      console.log("✅ Connected to server:", socket.id);
      setConnectionStatus("connected");
      setError(null);
    });

    socket.on("disconnect", () => {
      console.log("❌ Disconnected from server");
      setConnectionStatus("disconnected");
    });

    socket.on("connect_error", (err) => {
      console.error("Connection error:", err);
      setConnectionStatus("error");
      setError(err.message);
    });

    // Process incoming messages from the data socket
    socket.on("message", (msg) => {
      console.log("Received message:", msg);
      
      if (msg?.type === "sf") {
        // Update the stock data
        setLatestStocks(prev => ({
          ...prev,
          [msg.symbol]: {
            symbol: msg.symbol,
            ltp: msg.ltp,
            open: msg.open_price,
            high: msg.high_price,
            low: msg.low_price,
            volume: msg.vol_traded_today,
            timestamp: new Date().toISOString()
          }
        }));
      }
    });

    // Bullish signals
    socket.on("bullishSignal", (signal) => {
      console.log("🚨 New bullish signal:", signal);
      setBullishSignals(prev => {
        // Add new signal to the beginning of the array
        const newSignals = [signal, ...prev];
        // Keep only the last 10 signals
        return newSignals.slice(0, 10);
      });
    });

    // Initial bullish signals
    socket.on("bullishSignals", (signals) => {
      console.log("🚨 Initial bullish signals:", signals);
      setBullishSignals(signals);
    });

    // Cleanup on unmount
    return () => {
      socket.off("connect");
      socket.off("disconnect");
      socket.off("connect_error");
      socket.off("message");
      socket.off("bullishSignal");
      socket.off("bullishSignals");
      socket.disconnect();
    };
  }, []);

  // Handle resolution change
  const handleResolutionChange = async (newResolution) => {
    try {
      setIsChangingResolution(true);
      setError(null);
      
      const response = await fetch("http://localhost:4000/api/change-resolution", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ resolution: newResolution })
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || "Failed to change resolution");
      }
      
      setResolution(newResolution);
      console.log(`Resolution changed to ${newResolution}`);
    } catch (err) {
      console.error("Error changing resolution:", err);
      setError(err.message);
    } finally {
      setIsChangingResolution(false);
    }
  };

  // Format timestamp to readable time
  const formatTime = (timestamp) => {
    if (!timestamp) return "N/A";
    const date = new Date(timestamp);
    return date.toLocaleTimeString();
  };

  return (
    <div className="p-6 max-w-5xl mx-auto text-white space-y-6">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-2xl font-bold">📈 Live Stock Feed</h2>
        <div className={`px-3 py-1 rounded-full text-sm ${
          connectionStatus === "connected" ? "bg-green-600" : 
          connectionStatus === "error" ? "bg-red-600" : "bg-yellow-600"
        }`}>
          {connectionStatus === "connected" ? "Connected" : 
           connectionStatus === "error" ? "Error" : "Disconnected"}
        </div>
      </div>

      {error && (
        <div className="bg-red-800 p-3 rounded-lg mb-4">
          <p className="font-semibold">Error:</p>
          <p>{error}</p>
        </div>
      )}

      <div className="bg-gray-800 p-4 rounded-lg mb-4">
        <h3 className="text-lg font-semibold mb-2">Resolution Settings</h3>
        <div className="flex flex-wrap gap-2">
          {Object.values(RESOLUTIONS).map((res) => (
            <button
              key={res.value}
              onClick={() => handleResolutionChange(res.value)}
              disabled={isChangingResolution || resolution === res.value}
              className={`px-3 py-1 rounded ${
                resolution === res.value 
                  ? "bg-blue-600 cursor-default" 
                  : "bg-gray-700 hover:bg-gray-600"
              } ${isChangingResolution ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              {res.label}
            </button>
          ))}
        </div>
        {isChangingResolution && (
          <p className="text-sm text-gray-400 mt-2">Changing resolution...</p>
        )}
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {Object.values(latestStocks).map((stock) => (
          <div key={stock.symbol} className="bg-gray-800 p-4 rounded-xl shadow-md space-y-1">
            <h3 className="text-lg font-semibold">{stock.symbol}</h3>
            <p>LTP: ₹{stock.ltp?.toFixed(2) || "N/A"}</p>
            <p>Open: ₹{stock.open?.toFixed(2) || "N/A"}</p>
            <p>High: ₹{stock.high?.toFixed(2) || "N/A"}</p>
            <p>Low: ₹{stock.low?.toFixed(2) || "N/A"}</p>
            <p>Volume: {stock.volume?.toLocaleString() || "N/A"}</p>
            <p className="text-xs text-gray-400">Updated: {formatTime(stock.timestamp)}</p>
          </div>
        ))}
      </div>

      {bullishSignals.length > 0 && (
        <>
          <h2 className="text-xl font-bold mt-8">🚀 Bullish Signals</h2>
          <div className="bg-green-700 p-4 rounded-lg text-white">
            {bullishSignals.map((signal, index) => (
              <div key={index} className="border-b border-white/30 py-2">
                <p>📍 Symbol: {signal.symbol}</p>
                <p>✅ Signal Time: {formatTime(signal.timestamp)}</p>
                <p>💰 Price: ₹{signal.signal?.close?.toFixed(2) || "N/A"}</p>
              </div>
            ))}
          </div>
        </>
      )}

      {Object.keys(latestStocks).length === 0 && (
        <div className="text-center py-8 text-gray-400">
          <p>Waiting for stock data...</p>
        </div>
      )}
    </div>
  );
} 