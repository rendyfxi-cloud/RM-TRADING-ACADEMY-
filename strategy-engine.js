
/*
 RM Trading Academy
 Strategy Engine v0.1
 EMA 20 / EMA 50 + EMA Zone + Engulfing

 Signals only. No broker orders.
 Historical candles must be oldest first.
 Each candle: {time, open, high, low, close}
*/

(function (global) {
  "use strict";

  const DEFAULTS = {
    fastLength: 20,
    slowLength: 50,
    slopeLookback: 3,
    zoneLookback: 5,
    minimumSeparationATR: 0.10,
    atrLength: 14
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

  function analyze(inputCandles, options = {}) {
    const settings = { ...DEFAULTS, ...options };

    if (!Array.isArray(inputCandles)) {
      throw new Error("Candles must be an array.");
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
        c.low > Math.min(c.open, c.close)
      ) {
        throw new Error("Invalid OHLC candle.");
      }
    }

    const closes = candles.map(c => c.close);
    const fast = ema(closes, settings.fastLength);
    const slow = ema(closes, settings.slowLength);
    const volatility = atr(candles, settings.atrLength);

    const signals = [];

    const start = Math.max(
      settings.slowLength + settings.slopeLookback,
      settings.atrLength,
      settings.zoneLookback + 1
    );

    for (let i = start; i < candles.length; i++) {
      const current = candles[i];
      const previous = candles[i - 1];

      if (
        fast[i] === null ||
        slow[i] === null ||
        volatility[i] === null
      ) continue;

      const separation = Math.abs(fast[i] - slow[i]);

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

      let touchedZone = false;

      const from = Math.max(
        0,
        i - settings.zoneLookback + 1
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
          touchedZone = true;
          break;
        }
      }

      if (!enoughSeparation || !touchedZone) {
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

      if (direction) {
        signals.push({
          index: i,
          time: current.time,
          symbol: options.symbol || "EURUSD",
          direction,
          entryReference: current.close,
          ema20: fast[i],
          ema50: slow[i],
          atr: volatility[i],
          reason: "EMA trend + zone return + engulfing"
        });
      }
    }

    return {
      version: "0.1",
      mode: "SIGNALS_ONLY",
      candlesProcessed: candles.length,
      signalCount: signals.length,
      signals,
      indicators: {
        ema20: fast,
        ema50: slow,
        atr: volatility
      }
    };
  }

  global.RMStrategy = {
    version: "0.1",
    settings: DEFAULTS,
    ema,
    atr,
    analyze
  };

})(window);
