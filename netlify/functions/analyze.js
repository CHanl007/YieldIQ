const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

// ── MATH ENGINE ──────────────────────────────────────────────────────────────

function calcMortgage(principal, annualRate, termYears, isIO) {
  if (isIO) return principal * (annualRate / 100 / 12);
  const r = annualRate / 100 / 12;
  const n = termYears * 12;
  if (r === 0) return principal / n;
  return principal * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
}

function calcIRR(cashflows, guess = 0.1) {
  let rate = guess;
  for (let i = 0; i < 200; i++) {
    let npv = 0, dnpv = 0;
    for (let t = 0; t < cashflows.length; t++) {
      npv  += cashflows[t] / Math.pow(1 + rate, t);
      dnpv -= t * cashflows[t] / Math.pow(1 + rate, t + 1);
    }
    const newRate = rate - npv / dnpv;
    if (Math.abs(newRate - rate) < 1e-7) return newRate;
    rate = newRate;
  }
  return rate;
}

function runAnalysis(d) {
  const purchasePrice   = parseFloat(d.purchasePrice);
  const downPct         = parseFloat(d.downPaymentPct) / 100;
  const interestRate    = parseFloat(d.interestRate);
  const loanTerm        = parseInt(d.loanTerm) || 30;
  const isIO            = d.loanType === 'io';
  const monthlyRent     = parseFloat(d.monthlyRent);
  const vacancyRate     = parseFloat(d.vacancyRate || 5) / 100;
  const rentGrowth      = parseFloat(d.rentGrowth || 3) / 100;
  const appreciation    = parseFloat(d.appreciation || 3) / 100;
  const taxes           = parseFloat(d.taxes || 0);
  const insurance       = parseFloat(d.insurance || 0);
  const hoa             = parseFloat(d.hoa || 0);
  const maintenance     = parseFloat(d.maintenance || 0);
  const mgmt            = parseFloat(d.mgmt || 0);
  const other           = parseFloat(d.other || 0);
  const capex           = parseFloat(d.capex || 0);
  const holdPeriod      = parseInt(d.holdPeriod) || 10;
  const targetReturn    = parseFloat(d.targetReturn || 10) / 100;
  const sellingCostsPct = parseFloat(d.sellingCosts || 6) / 100;

  const downPayment          = purchasePrice * downPct;
  const loanAmount           = purchasePrice - downPayment;
  const mortgage             = calcMortgage(loanAmount, interestRate, loanTerm, isIO);
  const totalMonthlyExpenses = taxes + insurance + hoa + maintenance + mgmt + other + capex;
  const effectiveRentYr1     = monthlyRent * 12 * (1 - vacancyRate);
  const annualExpenses       = totalMonthlyExpenses * 12;
  const annualMortgage       = mortgage * 12;
  const annualCashflowYr1    = effectiveRentYr1 - annualExpenses - annualMortgage;
  const monthlyCashflow      = annualCashflowYr1 / 12;
  const cocReturn            = (annualCashflowYr1 / downPayment) * 100;
  const grm                  = purchasePrice / (monthlyRent * 12);
  const breakEvenMonthly     = (mortgage + totalMonthlyExpenses) / (1 - vacancyRate);

  // Build annual cashflows for IRR
  const flows = [-downPayment];
  for (let yr = 1; yr <= holdPeriod; yr++) {
    const rentThisYear = monthlyRent * 12 * Math.pow(1 + rentGrowth, yr - 1) * (1 - vacancyRate);
    const cf = rentThisYear - annualExpenses - annualMortgage;
    if (yr === holdPeriod) {
      const exitPrice = purchasePrice * Math.pow(1 + appreciation, holdPeriod);
      const exitCosts = exitPrice * sellingCostsPct;
      let balance = loanAmount;
      if (!isIO) {
        const r = interestRate / 100 / 12;
        const n = loanTerm * 12;
        const paid = holdPeriod * 12;
        balance = loanAmount * (Math.pow(1+r,n) - Math.pow(1+r,paid)) / (Math.pow(1+r,n) - 1);
      }
      flows.push(cf + exitPrice - exitCosts - balance);
    } else {
      flows.push(cf);
    }
  }

  const irrPct = calcIRR(flows) * 100;

  // Max purchase price via binary search (targeting same CoC as target return)
  function cocAtPrice(price) {
    const dp   = price * downPct;
    const loan = price - dp;
    const mtg  = calcMortgage(loan, interestRate, loanTerm, isIO);
    const acf  = effectiveRentYr1 - annualExpenses - (mtg * 12);
    return acf / dp;
  }

  let lo = purchasePrice * 0.3, hi = purchasePrice * 2.5;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (cocAtPrice(mid) > targetReturn) lo = mid; else hi = mid;
  }
  const maxPrice = (lo + hi) / 2;

  // Year-by-year table
  const yearlyTable = [];
  for (let yr = 1; yr <= Math.min(holdPeriod, 10); yr++) {
    const rent = monthlyRent * 12 * Math.pow(1 + rentGrowth, yr - 1) * (1 - vacancyRate);
    const cf   = rent - annualExpenses - annualMortgage;
    const coc  = (cf / downPayment) * 100;
    yearlyTable.push({ yr, rent: Math.round(rent), cf: Math.round(cf), coc: coc.toFixed(2) });
  }

  const diff    = irrPct - (targetReturn * 100);
  let verdict, verdictColor, verdictBg;
  if (diff >= 1) {
    verdict = `GO — Your IRR of ${irrPct.toFixed(2)}% exceeds your ${(targetReturn*100).toFixed(1)}% target by ${diff.toFixed(1)}%.`;
    verdictColor = '#1a7a52'; verdictBg = '#e8f5ee';
  } else if (diff >= -1) {
    verdict = `BORDERLINE — IRR of ${irrPct.toFixed(2)}% is within 1% of your target. Consider negotiating the price down.`;
    verdictColor = '#7a5f00'; verdictBg = '#fefae8';
  } else {
    verdict = `NO-GO — IRR of ${irrPct.toFixed(2)}% misses your ${(targetReturn*100).toFixed(1)}% target by ${Math.abs(diff).toFixed(1)}%. Max price to hit your target: $${Math.round(maxPrice).toLocaleString()}.`;
    verdictColor = '#c0392b'; verdictBg = '#fdf0ee';
  }

  return {
    downPayment, loanAmount, mortgage, totalMonthlyExpenses,
    effectiveRentYr1, annualCashflowYr1, monthlyCashflow,
    cocReturn, grm, breakEvenMonthly, irrPct, maxPrice,
    yearlyTable, verdict, verdictColor, verdictBg,
    targetReturnPct: targetReturn * 100, holdPeriod
  };
}

// ── EMAIL TEMPLATE ────────────────────────────────────────────────────────────

function fmt(n)    { return '$' + Math.round(n).toLocaleString(); }
function fmtP(n)   { return parseFloat(n).toFixed(2) + '%'; }
function fmtCF(n)  { return (n >= 0 ? '+' : '') + fmt(n) + '/mo'; }

function buildEmail(d, r) {
  const rows = r.yearlyTable.map(y => `
    <tr>
      <td style="padding:10px 14px; border-bottom:1px solid #eee; font-family:'JetBrains Mono',monospace; font-size:13px; color:#4a5e72;">Year ${y.yr}</td>
      <td style="padding:10px 14px; border-bottom:1px solid #eee; font-family:'JetBrains Mono',monospace; font-size:13px; text-align:right;">${fmt(y.rent)}</td>
      <td style="padding:10px 14px; border-bottom:1px solid #eee; font-family:'JetBrains Mono',monospace; font-size:13px; text-align:right; color:${y.cf >= 0 ? '#1a7a52' : '#c0392b'};">${(y.cf >= 0 ? '+' : '') + fmt(y.cf)}</td>
      <td style="padding:10px 14px; border-bottom:1px solid #eee; font-family:'JetBrains Mono',monospace; font-size:13px; text-align:right; color:${parseFloat(y.coc) >= r.targetReturnPct ? '#1a7a52' : '#c0392b'};">${y.coc}%</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>YieldIQ Property Report</title>
</head>
<body style="margin:0; padding:0; background:#f4efe6; font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4efe6; padding:40px 20px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%;">

  <!-- HEADER -->
  <tr><td style="background:#0b1f3a; border-radius:8px 8px 0 0; padding:32px 40px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td>
          <span style="font-family:Georgia,serif; font-size:26px; font-weight:700; color:#ffffff; letter-spacing:0.3px;">
            Yield<em style="color:#c9a84c; font-style:italic;">IQ</em>
          </span>
        </td>
        <td align="right">
          <span style="font-size:11px; font-weight:600; letter-spacing:2px; text-transform:uppercase; color:#7a90a8;">Property Analysis Report</span>
        </td>
      </tr>
    </table>
  </td></tr>

  <!-- PROPERTY BANNER -->
  <tr><td style="background:#122847; padding:20px 40px; border-bottom:2px solid #c9a84c;">
    <p style="margin:0; font-size:18px; font-weight:600; color:#ffffff;">${d.address}</p>
    <p style="margin:4px 0 0; font-size:12px; color:#7a90a8; font-family:'Courier New',monospace; letter-spacing:0.5px;">${d.propType.toUpperCase()} · ${d.holdPeriod}-YEAR HOLD · ${d.loanType.toUpperCase()} LOAN</p>
  </td></tr>

  <!-- VERDICT BAR -->
  <tr><td style="background:${r.verdictBg}; border:2px solid ${r.verdictColor}33; padding:20px 40px;">
    <p style="margin:0; font-size:14px; font-weight:700; color:${r.verdictColor}; letter-spacing:0.3px;">${r.verdict}</p>
  </td></tr>

  <!-- MAIN METRICS -->
  <tr><td style="background:#ffffff; padding:32px 40px;">
    <p style="margin:0 0 20px; font-size:11px; font-weight:700; letter-spacing:2px; text-transform:uppercase; color:#9aafbf;">Key Metrics</p>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td width="50%" style="padding-bottom:16px; padding-right:12px;">
          <div style="background:#f7f9fb; border:1px solid #e0e7ee; border-radius:6px; padding:16px;">
            <p style="margin:0 0 6px; font-size:10px; font-weight:600; letter-spacing:1px; text-transform:uppercase; color:#7a90a8; font-family:'Courier New',monospace;">Monthly Cash Flow</p>
            <p style="margin:0; font-size:24px; font-weight:700; color:${r.monthlyCashflow >= 0 ? '#1a7a52' : '#c0392b'}; font-family:Georgia,serif;">${fmtCF(r.monthlyCashflow)}</p>
          </div>
        </td>
        <td width="50%" style="padding-bottom:16px; padding-left:12px;">
          <div style="background:#f7f9fb; border:1px solid #e0e7ee; border-radius:6px; padding:16px;">
            <p style="margin:0 0 6px; font-size:10px; font-weight:600; letter-spacing:1px; text-transform:uppercase; color:#7a90a8; font-family:'Courier New',monospace;">Levered IRR</p>
            <p style="margin:0; font-size:24px; font-weight:700; color:#b8922e; font-family:Georgia,serif;">${fmtP(r.irrPct)}</p>
          </div>
        </td>
      </tr>
      <tr>
        <td width="50%" style="padding-right:12px;">
          <div style="background:#f7f9fb; border:1px solid #e0e7ee; border-radius:6px; padding:16px;">
            <p style="margin:0 0 6px; font-size:10px; font-weight:600; letter-spacing:1px; text-transform:uppercase; color:#7a90a8; font-family:'Courier New',monospace;">Cash-on-Cash Return</p>
            <p style="margin:0; font-size:24px; font-weight:700; color:${r.cocReturn >= r.targetReturnPct ? '#1a7a52' : '#c0392b'}; font-family:Georgia,serif;">${fmtP(r.cocReturn)}</p>
          </div>
        </td>
        <td width="50%" style="padding-left:12px;">
          <div style="background:#f7f9fb; border:1px solid #e0e7ee; border-radius:6px; padding:16px;">
            <p style="margin:0 0 6px; font-size:10px; font-weight:600; letter-spacing:1px; text-transform:uppercase; color:#7a90a8; font-family:'Courier New',monospace;">Max Purchase Price</p>
            <p style="margin:0; font-size:24px; font-weight:700; color:#0b1f3a; font-family:Georgia,serif;">${fmt(r.maxPrice)}</p>
          </div>
        </td>
      </tr>
    </table>

    <!-- DETAIL TABLE -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px; border:1px solid #e0e7ee; border-radius:6px; overflow:hidden;">
      <tr style="background:#f7f9fb;">
        <td style="padding:10px 14px; font-size:10px; font-weight:700; letter-spacing:1px; text-transform:uppercase; color:#9aafbf;">Metric</td>
        <td style="padding:10px 14px; font-size:10px; font-weight:700; letter-spacing:1px; text-transform:uppercase; color:#9aafbf; text-align:right;">Value</td>
      </tr>
      <tr><td style="padding:10px 14px; border-top:1px solid #eee; font-size:13px; color:#4a5e72;">Monthly Mortgage Payment</td><td style="padding:10px 14px; border-top:1px solid #eee; font-family:'Courier New',monospace; font-size:13px; text-align:right;">${fmt(r.mortgage)}</td></tr>
      <tr><td style="padding:10px 14px; border-top:1px solid #eee; font-size:13px; color:#4a5e72;">Monthly Operating Expenses</td><td style="padding:10px 14px; border-top:1px solid #eee; font-family:'Courier New',monospace; font-size:13px; text-align:right;">${fmt(r.totalMonthlyExpenses)}</td></tr>
      <tr><td style="padding:10px 14px; border-top:1px solid #eee; font-size:13px; color:#4a5e72;">Effective Annual Rent (after vacancy)</td><td style="padding:10px 14px; border-top:1px solid #eee; font-family:'Courier New',monospace; font-size:13px; text-align:right;">${fmt(r.effectiveRentYr1)}</td></tr>
      <tr><td style="padding:10px 14px; border-top:1px solid #eee; font-size:13px; color:#4a5e72;">Break-Even Monthly Rent</td><td style="padding:10px 14px; border-top:1px solid #eee; font-family:'Courier New',monospace; font-size:13px; text-align:right;">${fmt(r.breakEvenMonthly)}</td></tr>
      <tr><td style="padding:10px 14px; border-top:1px solid #eee; font-size:13px; color:#4a5e72;">Gross Rent Multiplier</td><td style="padding:10px 14px; border-top:1px solid #eee; font-family:'Courier New',monospace; font-size:13px; text-align:right;">${r.grm.toFixed(1)}x</td></tr>
      <tr><td style="padding:10px 14px; border-top:1px solid #eee; font-size:13px; color:#4a5e72;">Down Payment</td><td style="padding:10px 14px; border-top:1px solid #eee; font-family:'Courier New',monospace; font-size:13px; text-align:right;">${fmt(r.downPayment)}</td></tr>
      <tr><td style="padding:10px 14px; border-top:1px solid #eee; font-size:13px; color:#4a5e72;">Loan Amount</td><td style="padding:10px 14px; border-top:1px solid #eee; font-family:'Courier New',monospace; font-size:13px; text-align:right;">${fmt(r.loanAmount)}</td></tr>
      <tr><td style="padding:10px 14px; border-top:1px solid #eee; font-size:13px; color:#4a5e72;">Your Target IRR</td><td style="padding:10px 14px; border-top:1px solid #eee; font-family:'Courier New',monospace; font-size:13px; text-align:right;">${fmtP(r.targetReturnPct)}</td></tr>
    </table>

    <!-- YEAR BY YEAR -->
    <p style="margin:28px 0 14px; font-size:11px; font-weight:700; letter-spacing:2px; text-transform:uppercase; color:#9aafbf;">Year-by-Year Performance</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e0e7ee; border-radius:6px; overflow:hidden;">
      <tr style="background:#f7f9fb;">
        <td style="padding:10px 14px; font-size:10px; font-weight:700; letter-spacing:1px; text-transform:uppercase; color:#9aafbf;">Year</td>
        <td style="padding:10px 14px; font-size:10px; font-weight:700; letter-spacing:1px; text-transform:uppercase; color:#9aafbf; text-align:right;">Eff. Rent</td>
        <td style="padding:10px 14px; font-size:10px; font-weight:700; letter-spacing:1px; text-transform:uppercase; color:#9aafbf; text-align:right;">Net Cash Flow</td>
        <td style="padding:10px 14px; font-size:10px; font-weight:700; letter-spacing:1px; text-transform:uppercase; color:#9aafbf; text-align:right;">CoC Return</td>
      </tr>
      ${rows}
    </table>

    <!-- NOTES -->
    ${d.notes ? `<div style="margin-top:24px; background:#f7f9fb; border:1px solid #e0e7ee; border-radius:6px; padding:16px;">
      <p style="margin:0 0 6px; font-size:10px; font-weight:700; letter-spacing:1px; text-transform:uppercase; color:#9aafbf;">Your Notes</p>
      <p style="margin:0; font-size:13px; color:#4a5e72; line-height:1.6;">${d.notes}</p>
    </div>` : ''}
  </td></tr>

  <!-- PREMIUM UPSELL -->
  <tr><td style="background:#fefae8; border:1px solid #c9a84c33; padding:24px 40px;">
    <p style="margin:0 0 8px; font-size:12px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; color:#b8922e;">Unlock Premium Intelligence</p>
    <p style="margin:0 0 16px; font-size:13px; color:#4a5e72; line-height:1.6;">Get local rent comps, rent growth trends, expense benchmarks vs. market, and a personalized hold/sell/refinance recommendation for this property.</p>
    <a href="https://yieldiq.co" style="display:inline-block; background:#0b1f3a; color:#f4efe6; padding:11px 24px; border-radius:4px; font-size:12px; font-weight:700; letter-spacing:1px; text-transform:uppercase; text-decoration:none;">Learn About Premium →</a>
  </td></tr>

  <!-- FOOTER -->
  <tr><td style="background:#0b1f3a; border-radius:0 0 8px 8px; padding:24px 40px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td>
          <span style="font-family:Georgia,serif; font-size:18px; font-weight:700; color:#ffffff;">Yield<em style="color:#c9a84c; font-style:italic;">IQ</em></span>
          <p style="margin:6px 0 0; font-size:11px; color:#7a90a8; letter-spacing:0.5px;">Built for real investors.</p>
        </td>
        <td align="right">
          <p style="margin:0; font-size:11px; color:#7a90a8;">© 2026 YieldIQ. All rights reserved.</p>
          <p style="margin:4px 0 0; font-size:11px; color:#4a5e72;">This report is for informational purposes only and does not constitute financial advice.</p>
        </td>
      </tr>
    </table>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

// ── HANDLER ───────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: 'Method not allowed' };
  }

  try {
    const d = JSON.parse(event.body);

    // Validate required fields
    const required = ['address', 'purchasePrice', 'downPaymentPct', 'interestRate', 'monthlyRent', 'firstName', 'email'];
    for (const field of required) {
      if (!d[field]) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: `Missing required field: ${field}` }) };
      }
    }

    // Run the analysis
    const results = runAnalysis(d);

    // Build and send the email
    const emailHtml = buildEmail(d, results);

    await resend.emails.send({
      from: 'YieldIQ Reports <onboarding@resend.dev>',
      to: d.email,
      subject: `Your YieldIQ Property Report — ${d.address}`,
      html: emailHtml,
    });

    // Also notify yourself
    await resend.emails.send({
      from: 'YieldIQ Reports <onboarding@resend.dev>',
      to: 'con3689@gmail.com',
      subject: `New Analysis Submitted — ${d.address} (${d.firstName} ${d.lastName || ''})`,
      html: `<p>New report request from <strong>${d.firstName} ${d.lastName || ''}</strong> (${d.email}).</p>
             <p>Property: ${d.address}</p>
             <p>Purchase Price: $${parseInt(d.purchasePrice).toLocaleString()}</p>
             <p>Monthly Rent: $${parseInt(d.monthlyRent).toLocaleString()}</p>
             <p>IRR: ${results.irrPct.toFixed(2)}%</p>
             <p>Verdict: ${results.verdict}</p>
             ${d.notes ? `<p>Notes: ${d.notes}</p>` : ''}`,
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        preview: {
          mortgage:      Math.round(results.mortgage),
          monthlyCashflow: Math.round(results.monthlyCashflow),
          cocReturn:     results.cocReturn.toFixed(2),
          grm:           results.grm.toFixed(1),
          breakEven:     Math.round(results.breakEvenMonthly),
          irr:           results.irrPct.toFixed(2),
          maxPrice:      Math.round(results.maxPrice),
          verdict:       results.verdict,
          verdictColor:  results.verdictColor,
          verdictBg:     results.verdictBg,
        }
      }),
    };

  } catch (err) {
    console.error('Analysis error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Something went wrong. Please try again.' }),
    };
  }
};
