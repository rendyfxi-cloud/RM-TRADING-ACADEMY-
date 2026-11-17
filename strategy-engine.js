
/*
 RM Trading Academy
 Strategy Engine v0.2

 EMA 20 / EMA 50
 EMA Zone + Engulfing
 Confirmed Supply / Demand
 Liquidity Sweep Confirmation

 Historical signals only.
 No broker orders.
 Candles must be oldest first.
*/

(function (global) {
  "use strict";

  const DEFAULTS = {
    fastLength: 20,
    slowLength: 50,
    slopeLookback: 3,
    zoneLookback: 5,
    minimumSeparationATR: 0.10,
    atrLength: 14,

    // New v0.2 filters
    useSupplyDemand: false,
    useLiquiditySweep: false,

    swingLeft: 3,
    swingRight: 3,
    zoneWidthATR: 0.5,
    maxZoneAge: 200,
    liquidityLookback: 10,
    liquidityMaxAge: 3
  };

  function ema(values, period) {
    const result = Array(values.length).fill(null);

    if (values.length < period) return result;

    let sum = 0;

    for (let i = 0; i < period; i++) {
      sum += values[i];
    }

    let previous = sum / period;
    result[period - 1] = previous;

    const multiplier = 2 / (period + 1);

    for (let i = period; i < values.length; i++) {
      previous =
        values[i] * multiplier +
        previous * (1 - multiplier);

      result[i] = previous;
    }

    return result;
  }

  function atr(candles, period) {
    const ranges = candles.map((c, i) => {
      if (i === 0) return c.high - c.low;

      const previousClose = candles[i - 1].close;

      return Math.max(
        c.high - c.low,
        Math.abs(c.high - previousClose),
        Math.abs(c.low - previousClose)
      );
    });

    const result = Array(candles.length).fill(null);

    if (candles.length < period) return result;

    let sum = 0;

    for (let i = 0; i < period; i++) {
      sum += ranges[i];
    }

    let previous = sum / period;
    result[period - 1] = previous;

    for (let i = period; i < ranges.length; i++) {
      previous =
        (previous * (period - 1) + ranges[i]) / period;

      result[i] = previous;
    }

    return result;
  }

  function bullishEngulfing(previous, current) {
    return (
      previous.close < previous.open &&
      current.close > current.open &&
      current.open <= previous.close &&
      current.close >= previous.open
    );
  }

  function bearishEngulfing(previous, current) {
    return (
      previous.close > previous.open &&
      current.close < current.open &&
      current.open >= previous.close &&
      current.close <= previous.open
    );
  }

  function confirmedSwingHigh(candles, index, left, right) {
    const value = candles[index].high;

    for (let j = index - left; j <= index + right; j++) {
      if (j === index) continue;
      if (candles[j].high >= value) return false;
    }

    return true;
  }

  function confirmedSwingLow(candles, index, left, right) {
    const value = candles[index].low;

    for (let j = index - left; j <= index + right; j++) {
      if (j === index) continue;
      if (candles[j].low <= value) return false;
    }

    return true;
  }

  function createZone(type, pivotIndex, confirmedIndex,
                      candles, volatility, settings) {
    const pivot = candles[pivotIndex];
    const width =
      volatility[pivotIndex] * settings.zoneWidthATR;

    if (!(width > 0)) return null;

    const price = type === "DEMAND"
      ? pivot.low
      : pivot.high;

    return {
      type,
      pivotIndex,
      confirmedIndex,
      pivotTime: pivot.time,
      low: type === "DEMAND" ? price : price - width,
      high: type === "DEMAND" ? price + width : price,
      invalidated: false
    };
  }

  function touchesZone(candle, zone) {
    return (
      candle.low <= zone.high &&
      candle.high >= zone.low
    );
  }

  function findLiquiditySweeps(candles, index, settings) {
    const lookback = settings.liquidityLookback;
    const from = index - lookback;

    if (from < 0) {
      return { buy: false, sell: false };
    }

    let previousLow = Infinity;
    let previousHigh = -Infinity;

    for (let j = from; j < index; j++) {
      previousLow = Math.min(
        previousLow, candles[j].low
      );

      previousHigh = Math.max(
        previousHigh, candles[j].high
      );
    }

    const current = candles[index];

    return {
      buy:
        current.low < previousLow &&
        current.close > previousLow,

      sell:
        current.high > previousHigh &&
        current.close < previousHigh
    };
  }

  function analyze(inputCandles, options = {}) {
    const settings = { ...DEFAULTS, ...options };

    if (!Array.isArray(inputCandles)) {
      throw Error("Candles must be an array.");
    }

    const positiveIntegers = [
      "fastLength", "slowLength", "slopeLookback",
      "zoneLookback", "atrLength", "swingLeft",
      "swingRight", "maxZoneAge",
      "liquidityLookback", "liquidityMaxAge"
    ];

    for (const key of positiveIntegers) {
      if (!Number.isInteger(settings[key]) ||
          settings[key] < 1) {
        throw Error("Invalid setting: " + key);
      }
    }

    if (!(settings.zoneWidthATR > 0) ||
        !(settings.minimumSeparationATR >= 0)) {
      throw Error("Invalid ATR settings.");
    }

    const candles = inputCandles.map(c => ({
      time: c.time,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close)
    }));

    for (const c of candles) {
      if (
        ![c.open, c.high, c.low, c.close]
          .every(Number.isFinite) ||
        c.high < Math.max(c.open, c.close) ||
        c.low > Math.min(c.open, c.close) ||
        c.low > c.high
      ) {
        throw Error("Invalid OHLC candle.");
      }
    }

    const closes = candles.map(c => c.close);

    const fast = ema(closes, settings.fastLength);
    const slow = ema(closes, settings.slowLength);
    const volatility = atr(candles, settings.atrLength);

    const signals = [];
    const zones = [];
    const sweeps = [];

    let lastBuySweep = -Infinity;
    let lastSellSweep = -Infinity;

    const start = Math.max(
      settings.slowLength + settings.slopeLookback,
      settings.atrLength,
      settings.zoneLookback + 1,
      settings.swingLeft + settings.swingRight,
      settings.liquidityLookback
    );

    for (let i = start; i < candles.length; i++) {
      const current = candles[i];
      const previous = candles[i - 1];

      if (
        fast[i] === null ||
        slow[i] === null ||
        volatility[i] === null
      ) continue;

      // Confirm pivots only after right-side candles exist.
      const pivotIndex = i - settings.swingRight;

      if (
        pivotIndex >= settings.swingLeft &&
        volatility[pivotIndex] !== null
      ) {
        if (confirmedSwingLow(
          candles,
          pivotIndex,
          settings.swingLeft,
          settings.swingRight
        )) {
          const zone = createZone(
            "DEMAND", pivotIndex, i,
            candles, volatility, settings
          );

          if (zone) zones.push(zone);
        }

        if (confirmedSwingHigh(
          candles,
          pivotIndex,
          settings.swingLeft,
          settings.swingRight
        )) {
          const zone = createZone(
            "SUPPLY", pivotIndex, i,
            candles, volatility, settings
          );

          if (zone) zones.push(zone);
        }
      }

      // A zone invalidated by price cannot be reused.
      for (const zone of zones) {
        if (zone.invalidated) continue;

        if (zone.confirmedIndex >= i) continue;

        if (zone.type === "DEMAND" &&
            current.close < zone.low) {
          zone.invalidated = true;
        }

        if (zone.type === "SUPPLY" &&
            current.close > zone.high) {
          zone.invalidated = true;
        }
      }

      const sweep = findLiquiditySweeps(
        candles, i, settings
      );

      if (sweep.buy) {
        lastBuySweep = i;

        sweeps.push({
          index: i,
          time: current.time,
          direction: "BUY"
        });
      }

      if (sweep.sell) {
        lastSellSweep = i;

        sweeps.push({
          index: i,
          time: current.time,
          direction: "SELL"
        });
      }

      // Preserve original v0.1 EMA logic.
      const separation = Math.abs(
        fast[i] - slow[i]
      );

      const enoughSeparation =
        separation >=
        settings.minimumSeparationATR * volatility[i];

      const bullishTrend =
        fast[i] > slow[i] &&
        fast[i] > fast[i - settings.slopeLookback] &&
        slow[i] > slow[i - settings.slopeLookback];

      const bearishTrend =
        fast[i] < slow[i] &&
        fast[i] < fast[i - settings.slopeLookback] &&
        slow[i] < slow[i - settings.slopeLookback];

      let touchedEMAZone = false;

      const from = Math.max(
        0, i - settings.zoneLookback + 1
      );

      for (let j = from; j <= i; j++) {
        if (fast[j] === null || slow[j] === null) {
          continue;
        }

        const zoneHigh = Math.max(fast[j], slow[j]);
        const zoneLow = Math.min(fast[j], slow[j]);

        if (
          candles[j].low <= zoneHigh &&
          candles[j].high >= zoneLow
        ) {
          touchedEMAZone = true;
          break;
        }
      }

      if (!enoughSeparation || !touchedEMAZone) {
        continue;
      }

      let direction = null;

      if (
        bullishTrend &&
        bullishEngulfing(previous, current) &&
        current.close > fast[i]
      ) {
        direction = "BUY";
      }

      if (
        bearishTrend &&
        bearishEngulfing(previous, current) &&
        current.close < fast[i]
      ) {
        direction = "SELL";
      }

      if (!direction) continue;

      const relevantType =
        direction === "BUY" ? "DEMAND" : "SUPPLY";

      const matchingZones = zones.filter(zone =>
        zone.type === relevantType &&
        !zone.invalidated &&
        zone.confirmedIndex < i &&
        i - zone.confirmedIndex <= settings.maxZoneAge &&
        touchesZone(current, zone)
      );

      const hasSupplyDemand =
        matchingZones.length > 0;

      const hasLiquiditySweep =
        direction === "BUY"
          ? i - lastBuySweep <= settings.liquidityMaxAge
          : i - lastSellSweep <= settings.liquidityMaxAge;

      if (
        settings.useSupplyDemand &&
        !hasSupplyDemand
      ) continue;

      if (
        settings.useLiquiditySweep &&
        !hasLiquiditySweep
      ) continue;

      signals.push({
        index: i,
        time: current.time,
        symbol: options.symbol || "EURUSD",
        direction,
        entryReference: current.close,
        ema20: fast[i],
        ema50: slow[i],
        atr: volatility[i],

        supplyDemandConfirmed: hasSupplyDemand,
        liquiditySweepConfirmed: hasLiquiditySweep,

        zone: hasSupplyDemand
          ? {
              type: matchingZones[0].type,
              low: matchingZones[0].low,
              high: matchingZones[0].high
            }
          : null,

        reason:
          "EMA trend + zone return + engulfing" +
          (hasSupplyDemand ? " + supply/demand" : "") +
          (hasLiquiditySweep ? " + liquidity sweep" : "")
      });
    }

    return {
      version: "0.2",
      mode: "SIGNALS_ONLY",
      candlesProcessed: candles.length,
      signalCount: signals.length,
      signals,
      zones,
      sweeps,
      indicators: {
        ema20: fast,
        ema50: slow,
        atr: volatility
      }
    };
  }

  global.RMStrategy = {
    version: "0.2",
    settings: DEFAULTS,
    ema,
    atr,
    analyze
  };

})(window);
/*
 RM Trading Academy PRO v3.1
 Multi-Timeframe Supply & Demand Module

 Research and simulation only.
 No broker orders.
*/

(function (global) {
  "use strict";

  function parseTime(value) {
    if (typeof value === "number") return value;

    const normalized = String(value)
      .trim()
      .replace(" ", "T");

    const timestamp = Date.parse(
      /Z$|[+-]\d\d:\d\d$/.test(normalized)
        ? normalized
        : normalized + "Z"
    );

    if (!Number.isFinite(timestamp)) {
      throw new Error("Invalid candle timestamp: " + value);
    }

    return timestamp;
  }

  function aggregateCandles(candles, minutes) {
    const interval = minutes * 60000;
    const groups = [];

    for (const candle of candles) {
      const timestamp = parseTime(candle.time);
      const bucket = Math.floor(timestamp / interval) * interval;

      let group = groups[groups.length - 1];

      if (!group || group.bucket !== bucket) {
        group = {
          bucket,
          time: new Date(bucket).toISOString(),
          open: Number(candle.open),
          high: Number(candle.high),
          low: Number(candle.low),
          close: Number(candle.close),
          count: 0
        };
        groups.push(group);
      }

      group.high = Math.max(group.high, Number(candle.high));
      group.low = Math.min(group.low, Number(candle.low));
      group.close = Number(candle.close);
      group.count++;
    }

    return groups;
  }

  function findZones(candles, lookback = 20) {
    if (candles.length < lookback) {
      return null;
    }

    const recent = candles.slice(-lookback);

    const highest = Math.max(...recent.map(c => c.high));
    const lowest = Math.min(...recent.map(c => c.low));

    const range = highest - lowest;

    return {
      demand: {
        low: lowest,
        high: lowest + range * 0.15
      },
      supply: {
        low: highest - range * 0.15,
        high: highest
      }
    };
  }

  function analyzeMTF(candles, signalIndex, lookback = 20) {
    if (!Array.isArray(candles)) {
      throw new Error("Candles must be an array.");
    }

    if (
      !Number.isInteger(signalIndex) ||
      signalIndex < 0 ||
      signalIndex >= candles.length
    ) {
      throw new Error("Invalid signal index.");
    }

    // Only candles completed before the signal candle.
    const history = candles.slice(0, signalIndex);
    const signalTime = parseTime(candles[signalIndex].time);

    const h1 = aggregateCandles(history, 60)
      .filter(c => c.bucket + 3600000 <= signalTime);

    const h4 = aggregateCandles(history, 240)
      .filter(c => c.bucket + 14400000 <= signalTime);

    return {
      version: "3.1",
      m15: findZones(history, lookback),
      h1: findZones(h1, lookback),
      h4: findZones(h4, lookback)
    };
  }

  global.RMMTF = {
    version: "3.1",
    aggregateCandles,
    findZones,
    analyzeMTF
  };

})(window);

