
/*
 RM Trading Academy PRO v3.2
 Pine Script v6.1 Reference Engine

 Historical research and simulation only.
 No broker connections or live orders.

 Input: chronological M15 OHLC candles, oldest first.
 Candle timestamps: UTC opening times.

 Higher-timeframe calculations use completed
 H1/H4 candles only, avoiding future information.
*/

(function (global) {
  "use strict";

  const DEFAULTS = {
    fastLength: 20,
    slowLength: 50,
    slopeLookback: 3,
    minimumSeparationATR: 0.10,
    zoneLookback: 5,
    liquidityLength: 10,
    atrLength: 14,
    stopBufferATR: 0.10,
    rangeLookback: 20,
    rangeATRMultiple: 3.0,
    zonePercentage: 0.25,
    supplyDemandBufferATR: 0.25,
    minTick: 0.00001
  };

  function parseTime(value) {
    if (typeof value === "number") return value;

    const normalized = String(value)
      .trim()
      .replace(" ", "T");

    const time = Date.parse(
      /Z$|[+-]\d\d:\d\d$/.test(normalized)
        ? normalized
        : normalized + "Z"
    );

    if (!Number.isFinite(time)) {
      throw Error("Invalid candle timestamp: " + value);
    }

    return time;
  }

  function ema(values, length) {
    const result = Array(values.length).fill(null);
    if (!values.length) return result;

    // TradingView-style recursive EMA initialization.
    const alpha = 2 / (length + 1);
    let previous = values[0];
    result[0] = previous;

    for (let i = 1; i < values.length; i++) {
      previous = alpha * values[i] +
        (1 - alpha) * previous;
      result[i] = previous;
    }

    return result;
  }

  function atr(candles, length) {
    const result = Array(candles.length).fill(null);
    if (candles.length < length) return result;

    const tr = candles.map((c, i) => {
      if (i === 0) return c.high - c.low;

      const previousClose = candles[i - 1].close;

      return Math.max(
        c.high - c.low,
        Math.abs(c.high - previousClose),
        Math.abs(c.low - previousClose)
      );
    });

    let sum = 0;
    for (let i = 0; i < length; i++) sum += tr[i];

    let previous = sum / length;
    result[length - 1] = previous;

    for (let i = length; i < tr.length; i++) {
      previous =
        (previous * (length - 1) + tr[i]) / length;
      result[i] = previous;
    }

    return result;
  }

  function aggregateCandles(candles, minutes) {
    const interval = minutes * 60000;
    const groups = [];

    for (const c of candles) {
      const timestamp = parseTime(c.time);
      const bucket = Math.floor(timestamp / interval) * interval;

      let group = groups[groups.length - 1];

      if (!group || group.bucket !== bucket) {
        group = {
          bucket,
          time: new Date(bucket).toISOString(),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          count: 0
        };

        groups.push(group);
      }

      group.high = Math.max(group.high, c.high);
      group.low = Math.min(group.low, c.low);
      group.close = c.close;
      group.count++;
    }

    return groups;
  }

  function rangeAt(candles, volatility, end, settings) {
    const length = settings.rangeLookback;

    if (end < length - 1 ||
        volatility[end] === null) {
      return null;
    }

    let highest = -Infinity;
    let lowest = Infinity;

    for (let j = end - length + 1; j <= end; j++) {
      highest = Math.max(highest, candles[j].high);
      lowest = Math.min(lowest, candles[j].low);
    }

    const width = highest - lowest;
    const ranging =
      width <= volatility[end] * settings.rangeATRMultiple;

    return {
      high: highest,
      low: lowest,
      width,
      atr: volatility[end],
      ranging,
      supply: {
        low: highest - width * settings.zonePercentage,
        high: highest
      },
      demand: {
        low: lowest,
        high: lowest + width * settings.zonePercentage
      }
    };
  }

  function higherTimeframeData(candles, minutes, settings) {
    const aggregated = aggregateCandles(candles, minutes);
    const volatility = atr(aggregated, settings.atrLength);

    return {
      candles: aggregated,
      ranges: aggregated.map((_, i) =>
        rangeAt(aggregated, volatility, i, settings)
      )
    };
  }

  function completedRange(data, signalCloseTime, minutes) {
    const interval = minutes * 60000;

    for (let i = data.candles.length - 1; i >= 0; i--) {
      const c = data.candles[i];

      if (c.bucket + interval <= signalCloseTime &&
          c.count === minutes / 15) {
        return data.ranges[i];
      }
    }

    return null;
  }

  function nearSupply(close, range, buffer) {
    return !!(
      range &&
      range.ranging &&
      close <= range.supply.high &&
      close >= range.supply.low - buffer
    );
  }

  function nearDemand(close, range, buffer) {
    return !!(
      range &&
      range.ranging &&
      close >= range.demand.low &&
      close <= range.demand.high + buffer
    );
  }

  function bullishEngulf(previous, current) {
    return current.close > current.open &&
      previous.close < previous.open &&
      current.open <= previous.close &&
      current.close >= previous.open;
  }

  function bearishEngulf(previous, current) {
    return current.close < current.open &&
      previous.close > previous.open &&
      current.open >= previous.close &&
      current.close <= previous.open;
  }

  function analyze(inputCandles, options = {}) {
    const settings = { ...DEFAULTS, ...options };

    for (const key of [
      "fastLength", "slowLength", "slopeLookback",
      "zoneLookback", "liquidityLength",
      "atrLength", "rangeLookback"
    ]) {
      if (!Number.isInteger(settings[key]) ||
          settings[key] < 1) {
        throw Error("Invalid setting: " + key);
      }
    }

    if (!Array.isArray(inputCandles)) {
      throw Error("Candles must be an array.");
    }

    const candles = inputCandles.map(c => ({
      time: c.time,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close)
    }));

    let lastTime = -Infinity;

    for (const c of candles) {
      const time = parseTime(c.time);

      if (!Number.isFinite(c.open) ||
          !Number.isFinite(c.high) ||
          !Number.isFinite(c.low) ||
          !Number.isFinite(c.close) ||
          c.high < Math.max(c.open, c.close) ||
          c.low > Math.min(c.open, c.close) ||
          c.low > c.high ||
          time <= lastTime) {
        throw Error("Invalid or unordered OHLC candles.");
      }

      lastTime = time;
    }

    const closes = candles.map(c => c.close);
    const fast = ema(closes, settings.fastLength);
    const slow = ema(closes, settings.slowLength);
    const volatility = atr(candles, settings.atrLength);

    const h1 = higherTimeframeData(candles, 60, settings);
    const h4 = higherTimeframeData(candles, 240, settings);

    const signals = [];
    const sweeps = [];
    const diagnostics = {
      barsChecked: 0,
      bullishCandidates: 0,
      bearishCandidates: 0,
      blockedBySupply: 0,
      blockedByDemand: 0,
      blockedByTradeState: 0,
      confirmedSignals: 0
    };

    let lastBullReturn = -Infinity;
    let lastBearReturn = -Infinity;
    let lastBullReject = -Infinity;
    let lastBearReject = -Infinity;

    let latestBullRejectionLow = null;
    let latestBearRejectionHigh = null;

    let lastTradeExitBar = -1;
    let trade = null;

    let previousBuyCondition = false;
    let previousSellCondition = false;

    const trades = [];

    for (let i = 0; i < candles.length; i++) {
      const current = candles[i];
      const previous = candles[i - 1];

      if (!previous ||
          i < settings.slopeLookback ||
          volatility[i] === null) {
        continue;
      }

      diagnostics.barsChecked++;

      // Pine processes active trade exits before
      // evaluating fresh entry conditions.
      let tradeClosedThisBar = false;

      if (trade && i > trade.signalIndex) {
        const hitSL = trade.direction === "BUY"
          ? current.low <= trade.sl
          : current.high >= trade.sl;

        const hitTP3 = trade.direction === "BUY"
          ? current.high >= trade.tp3
          : current.low <= trade.tp3;

        if (hitSL || hitTP3) {
          trade.exitIndex = i;
          trade.exitTime = current.time;
          trade.exitReason = hitSL ? "SL" : "TP3";
          trade.exitPrice = hitSL ? trade.sl : trade.tp3;

          trades.push(trade);
          trade = null;
          tradeClosedThisBar = true;
          lastTradeExitBar = i;
        }
      }

      const zoneTop = Math.max(fast[i], slow[i]);
      const zoneBottom = Math.min(fast[i], slow[i]);

      const bullishBias = fast[i] > slow[i];
      const bearishBias = fast[i] < slow[i];

      const bullishSlope =
        fast[i] > fast[i - settings.slopeLookback] &&
        slow[i] > slow[i - settings.slopeLookback];

      const bearishSlope =
        fast[i] < fast[i - settings.slopeLookback] &&
        slow[i] < slow[i - settings.slopeLookback];

      const separationValid =
        Math.abs(fast[i] - slow[i]) >=
        volatility[i] * settings.minimumSeparationATR;

      const zoneTouched =
        current.low <= zoneTop &&
        current.high >= zoneBottom;

      const bullReturn = bullishBias && zoneTouched;
      const bearReturn = bearishBias && zoneTouched;

      const bullReject =
        bullReturn &&
        current.close > zoneTop &&
        current.close > current.open;

      const bearReject =
        bearReturn &&
        current.close < zoneBottom &&
        current.close < current.open;

      if (bullReturn) lastBullReturn = i;
      if (bearReturn) lastBearReturn = i;

      if (bullReject) {
        lastBullReject = i;
        latestBullRejectionLow = current.low;
      }

      if (bearReject) {
        lastBearReject = i;
        latestBearRejectionHigh = current.high;
      }

      let previousLow = Infinity;
      let previousHigh = -Infinity;

      if (i >= settings.liquidityLength) {
        for (
          let j = i - settings.liquidityLength;
          j < i;
          j++
        ) {
          previousLow = Math.min(previousLow, candles[j].low);
          previousHigh = Math.max(previousHigh, candles[j].high);
        }

        if (current.low < previousLow &&
            current.close > previousLow) {
          sweeps.push({
            index: i,
            time: current.time,
            direction: "BUY"
          });
        }

        if (current.high > previousHigh &&
            current.close < previousHigh) {
          sweeps.push({
            index: i,
            time: current.time,
            direction: "SELL"
          });
        }
      }

      const currentRange = rangeAt(
        candles, volatility, i, settings
      );

      // M15 candle closes 15 minutes after its timestamp.
      const signalCloseTime = parseTime(current.time) + 900000;

      const h1Range = completedRange(h1, signalCloseTime, 60);
      const h4Range = completedRange(h4, signalCloseTime, 240);

      const buffer =
        volatility[i] * settings.supplyDemandBufferATR;

      const buyBlocked =
        nearSupply(current.close, currentRange, buffer) ||
        nearSupply(current.close, h1Range, buffer) ||
        nearSupply(current.close, h4Range, buffer);

      const sellBlocked =
        nearDemand(current.close, currentRange, buffer) ||
        nearDemand(current.close, h1Range, buffer) ||
        nearDemand(current.close, h4Range, buffer);

      const recentBullReturn =
        i - lastBullReturn <= settings.zoneLookback;

      const recentBearReturn =
        i - lastBearReturn <= settings.zoneLookback;

      const recentBullReject =
        i - lastBullReject <= settings.zoneLookback;

      const recentBearReject =
        i - lastBearReject <= settings.zoneLookback;

      const freshBull =
        lastTradeExitBar < 0 ||
        (lastBullReturn > lastTradeExitBar &&
         lastBullReject > lastTradeExitBar);

      const freshBear =
        lastTradeExitBar < 0 ||
        (lastBearReturn > lastTradeExitBar &&
         lastBearReject > lastTradeExitBar);

      const buyCandidate =
        bullishBias &&
        bullishSlope &&
        separationValid &&
        recentBullReturn &&
        recentBullReject &&
        bullishEngulf(previous, current) &&
        current.close > zoneTop &&
        freshBull;

      const sellCandidate =
        bearishBias &&
        bearishSlope &&
        separationValid &&
        recentBearReturn &&
        recentBearReject &&
        bearishEngulf(previous, current) &&
        current.close < zoneBottom &&
        freshBear;

      if (buyCandidate) diagnostics.bullishCandidates++;
      if (sellCandidate) diagnostics.bearishCandidates++;

      if (buyCandidate && buyBlocked) {
        diagnostics.blockedBySupply++;
      }

      if (sellCandidate && sellBlocked) {
        diagnostics.blockedByDemand++;
      }

      const buyCondition = buyCandidate && !buyBlocked;
      const sellCondition = sellCandidate && !sellBlocked;

      // Pine uses a rising-edge condition:
      // signal now, but not on previous bar.
      const confirmedBuy =
        buyCondition &&
        !previousBuyCondition &&
        !trade &&
        !tradeClosedThisBar;

      const confirmedSell =
        sellCondition &&
        !previousSellCondition &&
        !trade &&
        !tradeClosedThisBar;

      if ((buyCondition || sellCondition) &&
          trade && !tradeClosedThisBar) {
        diagnostics.blockedByTradeState++;
      }

      previousBuyCondition = buyCondition;
      previousSellCondition = sellCondition;

      if (!confirmedBuy && !confirmedSell) continue;

      const direction = confirmedBuy ? "BUY" : "SELL";

      const stop = direction === "BUY"
        ? Math.min(
            latestBullRejectionLow -
              volatility[i] * settings.stopBufferATR,
            current.low -
              volatility[i] * settings.stopBufferATR
          )
        : Math.max(
            latestBearRejectionHigh +
              volatility[i] * settings.stopBufferATR,
            current.high +
              volatility[i] * settings.stopBufferATR
          );

      const entry = current.close;
      const riskDistance = Math.abs(entry - stop);

      if (!(riskDistance > settings.minTick)) continue;

      const sign = direction === "BUY" ? 1 : -1;

      trade = {
        signalIndex: i,
        signalTime: current.time,
        direction,
        entry,
        sl: stop,
        tp1: entry + sign * riskDistance,
        tp2: entry + sign * riskDistance * 2,
        tp3: entry + sign * riskDistance * 3,
        riskDistance,
        exitIndex: null,
        exitTime: null,
        exitReason: null,
        exitPrice: null
      };

      signals.push({
        index: i,
        time: current.time,
        symbol: options.symbol || "EURUSD",
        direction,
        entryReference: entry,
        ema20: fast[i],
        ema50: slow[i],
        atr: volatility[i],
        sl: stop,
        tp1: trade.tp1,
        tp2: trade.tp2,
        tp3: trade.tp3,
        reason:
          "Pine v6.1 EMA rejection + engulfing " +
          "+ M15/H1/H4 supply-demand protection"
      });

      diagnostics.confirmedSignals++;
    }

    return {
      version: "3.2",
      mode: "SIGNALS_ONLY",
      candlesProcessed: candles.length,
      signalCount: signals.length,
      signals,
      sweeps,
      trades,
      openTrade: trade,
      diagnostics,
      indicators: {
        ema20: fast,
        ema50: slow,
        atr: volatility
      }
    };
  }

  global.RMStrategy = {
    version: "3.2",
    settings: DEFAULTS,
    ema,
    atr,
    analyze
  };

})(window);
