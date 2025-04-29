"use client"

import React from "react"
import { useEffect, useRef, useState } from "react"
import TradeCard from "@/components/trade-card"
import TimeFilter from "@/components/time-filter"
import io, { Socket } from "socket.io-client"

type Trade = {
  symbol: string
  signal: {
    time: string
    open: number
    high: number
    low: number
    close: number
    volume: number
  }
  timestamp?: string | number
}

type EntryTime = {
  symbol: string
  time: string
  timestamp: number
  resolution: string
  lastCandleTime: string
  lastEntryTime: string
  lastEntryTimestamp: number
  candleStartTimes: string[]
}

// 🛠️ Utility function to safely parse timestamps
function parseTimestamp(timestamp?: string | number): string {
  if (!timestamp) return new Date().toISOString()

  if (typeof timestamp === "number") {
    return new Date(timestamp * 1000).toISOString()
  }

  if (typeof timestamp === "string") {
    return new Date(timestamp.replace(" ", "T")).toISOString()
  }

  return new Date().toISOString()
}

export default function TradesPage() {
  const [trades, setTrades] = useState<Trade[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedTime, setSelectedTime] = useState("D")
  const [entryTimes, setEntryTimes] = useState<EntryTime[]>([])
  const cacheRef = useRef<Trade[]>([])
  const socketRef = useRef<any>(null)
  const tradeOrderRef = useRef<string[]>([])

  useEffect(() => {
    socketRef.current = io("http://localhost:4000")

    socketRef.current.on("connect", () => {
      console.log("✅ Socket connected:", socketRef.current.id)
    })

    socketRef.current.on("bullishSignal", (data: Trade) => {
      console.log("🔥 Bullish signal received:", data)

      const formattedTrade: Trade = {
        symbol: data.symbol,
        signal: {
          time: parseTimestamp(data.timestamp),
          open: data.signal.open,
          high: data.signal.high,
          low: data.signal.low,
          close: data.signal.close,
          volume: data.signal.volume,
        },
        timestamp: data.timestamp,
      }

      setTrades((prev) => {
        const symbolExists = tradeOrderRef.current.includes(data.symbol)

        if (!symbolExists) {
          tradeOrderRef.current.push(data.symbol)
        }

        const filtered = prev.filter((t) => t.symbol !== data.symbol)
        const newTrades = [...filtered, formattedTrade]

        cacheRef.current = newTrades
        return newTrades
      })

      setLoading(false)
    })

    const fetchInitialData = async () => {
      try {
        // Change resolution first
        const resolutionRes = await fetch("http://localhost:4000/api/change-resolution", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ resolution: selectedTime })
        });

        if (!resolutionRes.ok) {
          throw new Error("Failed to change resolution");
        }

        const resolutionData = await resolutionRes.json();
        console.log("Resolution changed to:", resolutionData.resolution);

        // Initialize with empty array since we're not fetching signals directly
        const validTrades: Trade[] = [];
        tradeOrderRef.current = validTrades.map((trade) => trade.symbol);
        cacheRef.current = validTrades;
        setTrades(validTrades);
        
        // Clear entry times since we're not fetching them anymore
        setEntryTimes([]);
      } catch (error) {
        console.error("Error fetching initial data:", error);
      } finally {
        setLoading(false);
      }
    }

    fetchInitialData()

    return () => {
      if (socketRef.current) {
        socketRef.current.off("connect")
        socketRef.current.off("bullishSignal")
        socketRef.current.disconnect()
      }
    }
  }, [selectedTime])

  const handleTimeChange = (time: string) => {
    setSelectedTime(time)
  }

  const sortedTrades = [...trades].sort((a, b) => {
    const indexA = tradeOrderRef.current.indexOf(a.symbol)
    const indexB = tradeOrderRef.current.indexOf(b.symbol)
    return indexA - indexB
  })

  return (
    <div className="p-4 md:p-6 pb-20 md:pb-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-bold text-white">Trades</h1>
          <div className="flex items-center gap-3">
            <TimeFilter onTimeChange={handleTimeChange} />
          </div>
        </div>

        {loading ? (
          <div className="text-white">Loading...</div>
        ) : trades.length === 0 ? (
          <div className="text-white">No signals available</div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-2 gap-4">
            {sortedTrades.map((trade) => {
              const s = trade.signal
              const [date, _time] = s.time.split("T")
              const closePrice = s.close
              const entryPrice = (closePrice - 10).toFixed(2)
              const targetPrice = (closePrice + 10).toFixed(2)

              const entryInfo = entryTimes.find((e) => e.symbol === trade.symbol)
              const candleStart = entryInfo?.candleStartTimes?.at(-1) || _time

              return (
                <TradeCard
                  key={trade.symbol}
                  symbol={trade.symbol}
                  exchange="NSE"
                  type="EQU"
                  price={closePrice.toString()}
                  change="0"
                  changePercentage="0%"
                  entryPrice={entryPrice}
                  stopLoss={s.low.toString()}
                  target={targetPrice}
                  liveReturns="0"
                  estimatedGains="0"
                  entryTime={candleStart}
                  entrydate={date}
                  isProfit={true}
                />
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
} 