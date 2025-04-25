"use client";
import React, { useEffect, useState, useRef } from "react";
import io from "socket.io-client";

// Create socket connection with reconnection options
const socket = io("http://localhost:4000", {
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
});

export default function BullishStocks() {
  // Use a ref to store signals to prevent race conditions
  const signalsRef = useRef({});
  const [signals, setSignals] = useState([]);
  const [connectionStatus, setConnectionStatus] = useState("disconnected");
  const [lastUpdate, setLastUpdate] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  // Function to update signals state from the ref
  const updateSignalsState = () => {
    // Convert the signals object to an array and sort by timestamp (newest first)
    const signalsArray = Object.values(signalsRef.current)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    setSignals(signalsArray);
    setLastUpdate(new Date());
  };

  // Fetch initial bullish signals on component mount
  useEffect(() => {
    const fetchInitialSignals = async () => {
      try {
        setIsLoading(true);
        const response = await fetch("http://localhost:4000/api/bullish-signals");
        const data = await response.json();
        
        if (data.signals && Array.isArray(data.signals)) {
          // Reset the signals ref
          signalsRef.current = {};
          
          // Add each signal to the ref
          data.signals.forEach(signal => {
            if (signal.symbol) {
              signalsRef.current[signal.symbol] = signal;
            }
          });
          
          // Update the state
          updateSignalsState();
        }
      } catch (error) {
        console.error("Error fetching initial signals:", error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchInitialSignals();
  }, []);

  // Socket connection handling
  useEffect(() => {
    // Connection events
    socket.on("connect", () => {
      console.log("✅ Socket connected:", socket.id);
      setConnectionStatus("connected");
    });

    socket.on("disconnect", () => {
      console.log("❌ Socket disconnected");
      setConnectionStatus("disconnected");
    });

    socket.on("connect_error", (error) => {
      console.error("Socket connection error:", error);
      setConnectionStatus("error");
    });

    // Handle new bullish signals
    socket.on("bullishSignal", (data) => {
      console.log("🔥 Bullish signal received:", data);
      
      // Update the signals ref with the new signal
      if (data.symbol) {
        signalsRef.current[data.symbol] = data;
        
        // Update the state
        updateSignalsState();
      }
    });

    // Handle initial bullish signals batch
    socket.on("bullishSignals", (data) => {
      console.log("🔥 Initial bullish signals received:", data);
      
      // Reset the signals ref
      signalsRef.current = {};
      
      // Add each signal to the ref
      data.forEach(signal => {
        if (signal.symbol) {
          signalsRef.current[signal.symbol] = signal;
        }
      });
      
      // Update the state
      updateSignalsState();
      setIsLoading(false);
    });

    // Cleanup on unmount
    return () => {
      socket.off("connect");
      socket.off("disconnect");
      socket.off("connect_error");
      socket.off("bullishSignal");
      socket.off("bullishSignals");
      socket.disconnect();
    };
  }, []);

  // Format timestamp to readable time
  const formatTime = (timestamp) => {
    if (!timestamp) return "N/A";
    const date = new Date(timestamp);
    return date.toLocaleTimeString();
  };

  // Format date to readable date
  const formatDate = (timestamp) => {
    if (!timestamp) return "N/A";
    const date = new Date(timestamp);
    return date.toLocaleDateString();
  };

  return (
    <div className="p-6 bg-black text-white min-h-screen">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-yellow-400">
          🚀 Live Bullish Stocks
        </h1>
        <div className="flex items-center space-x-2">
          <div className={`w-3 h-3 rounded-full ${
            connectionStatus === "connected" ? "bg-green-500" : 
            connectionStatus === "error" ? "bg-red-500" : "bg-yellow-500"
          }`}></div>
          <span className="text-sm">
            {connectionStatus === "connected" ? "Connected" : 
             connectionStatus === "error" ? "Connection Error" : "Disconnected"}
          </span>
          {lastUpdate && (
            <span className="text-xs text-gray-400 ml-2">
              Last updated: {formatTime(lastUpdate)}
            </span>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="text-center py-8">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-yellow-400 mb-2"></div>
          <p className="text-gray-400">Loading bullish signals...</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full table-auto border-collapse border border-gray-700 text-sm">
            <thead className="bg-gray-800 text-yellow-300">
              <tr>
                <th className="border border-gray-700 px-4 py-2">#</th>
                <th className="border border-gray-700 px-4 py-2">Symbol</th>
                <th className="border border-gray-700 px-4 py-2">Date</th>
                <th className="border border-gray-700 px-4 py-2">Time</th>
                <th className="border border-gray-700 px-4 py-2">Close</th>
                <th className="border border-gray-700 px-4 py-2">Open</th>
                <th className="border border-gray-700 px-4 py-2">High</th>
                <th className="border border-gray-700 px-4 py-2">Low</th>
                <th className="border border-gray-700 px-4 py-2">Volume</th>
              </tr>
            </thead>
            <tbody>
              {signals.map(({ symbol, signal, timestamp }, index) => (
                <tr key={symbol} className="hover:bg-gray-800 transition">
                  <td className="border border-gray-700 px-4 py-2 text-center">{index + 1}</td>
                  <td className="border border-gray-700 px-4 py-2 text-green-400 font-semibold">{symbol}</td>
                  <td className="border border-gray-700 px-4 py-2">{formatDate(timestamp)}</td>
                  <td className="border border-gray-700 px-4 py-2">{formatTime(timestamp)}</td>
                  <td className="border border-gray-700 px-4 py-2 text-white">₹{signal.close?.toFixed(2) || "N/A"}</td>
                  <td className="border border-gray-700 px-4 py-2 text-green-300">₹{signal.open?.toFixed(2) || "N/A"}</td>
                  <td className="border border-gray-700 px-4 py-2 text-yellow-400">₹{signal.high?.toFixed(2) || "N/A"}</td>
                  <td className="border border-gray-700 px-4 py-2 text-red-400">₹{signal.low?.toFixed(2) || "N/A"}</td>
                  <td className="border border-gray-700 px-4 py-2 text-blue-300">{signal.volume?.toLocaleString() || "N/A"}</td>
                </tr>
              ))}
              {signals.length === 0 && (
                <tr>
                  <td colSpan={9} className="text-center py-4 text-gray-400">
                    No bullish signals yet. Waiting for signals...
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
} 