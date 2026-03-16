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

function buildReportUrl(d) {
  try {
    const encoded = Buffer.from(JSON.stringify(d)).toString('base64');
    return `https://yieldiq.co/report.html?p=${encoded}`;
  } catch(e) { return 'https://yieldiq.co'; }
}

function buildEmail(d, r, reportUrl) {
  const verdictColor = r.verdictColor;
  const verdictBg    = r.verdictBg;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Your YieldIQ Property Report</title>
</head>
<body style="margin:0;padding:0;background:#f0ebe2;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0ebe2;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

  <!-- HEADER -->
  <tr><td style="background:#0b1f3a;border-radius:10px 10px 0 0;padding:28px 40px 24px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td><span style="font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:700;color:#fff;letter-spacing:-0.3px;">Yield<em style="color:#c9a84c;font-style:italic;">IQ</em></span><span style="display:inline-block;width:5px;height:5px;background:#c9a84c;border-radius:50%;margin-left:3px;vertical-align:super;"></span></td>
      <td align="right"><span style="font-size:10px;font-weight:600;letter-spacing:2.5px;text-transform:uppercase;color:rgba(255,255,255,0.35);">Property Report</span></td>
    </tr></table>
  </td></tr>

  <!-- PROPERTY BAND -->
  <tr><td style="background:#122847;padding:20px 40px;border-bottom:3px solid #c9a84c;">
    <p style="margin:0 0 4px;font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.35);">Investment Property Analysis</p>
    <p style="margin:0 0 6px;font-size:20px;font-weight:700;color:#fff;line-height:1.2;">${d.address}</p>
    <p style="margin:0;font-size:11px;color:rgba(255,255,255,0.4);letter-spacing:0.5px;font-family:'Courier New',monospace;">${(d.propType||'SFR').toUpperCase()} &nbsp;·&nbsp; ${(d.loanType||'CONVENTIONAL').toUpperCase()} LOAN &nbsp;·&nbsp; ${d.holdPeriod}-YEAR HOLD &nbsp;·&nbsp; ${d.downPaymentPct}% DOWN</p>
  </td></tr>

  <!-- VERDICT -->
  <tr><td style="background:${verdictBg};padding:16px 40px;border-left:4px solid ${verdictColor};">
    <p style="margin:0;font-size:13px;font-weight:700;color:${verdictColor};line-height:1.5;">${r.verdict}</p>
  </td></tr>

  <!-- HERO METRICS -->
  <tr><td style="background:#fff;padding:32px 40px 24px;">

    <p style="margin:0 0 18px;font-size:10px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;color:#9aafbf;">Key Results</p>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
      <tr>
        <td width="33%" style="padding-right:8px;padding-bottom:12px;">
          <div style="background:#f7f9fb;border:1px solid #e8eef4;border-radius:8px;border-top:3px solid #b8922e;padding:16px 14px;">
            <p style="margin:0 0 6px;font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#9aafbf;font-family:'Courier New',monospace;">Levered IRR</p>
            <p style="margin:0;font-size:22px;font-weight:700;color:#b8922e;font-family:Georgia,serif;line-height:1;">${fmtP(r.irrPct)}</p>
            <p style="margin:4px 0 0;font-size:10px;color:#9aafbf;">over ${r.holdPeriod} years</p>
          </div>
        </td>
        <td width="33%" style="padding-right:8px;padding-bottom:12px;">
          <div style="background:#f7f9fb;border:1px solid #e8eef4;border-radius:8px;border-top:3px solid ${r.monthlyCashflow >= 0 ? '#1a7a52' : '#c0392b'};padding:16px 14px;">
            <p style="margin:0 0 6px;font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#9aafbf;font-family:'Courier New',monospace;">Monthly Cash Flow</p>
            <p style="margin:0;font-size:22px;font-weight:700;color:${r.monthlyCashflow >= 0 ? '#1a7a52' : '#c0392b'};font-family:Georgia,serif;line-height:1;">${fmtCF(r.monthlyCashflow)}</p>
            <p style="margin:4px 0 0;font-size:10px;color:#9aafbf;">after all expenses</p>
          </div>
        </td>
        <td width="33%" style="padding-bottom:12px;">
          <div style="background:#f7f9fb;border:1px solid #e8eef4;border-radius:8px;border-top:3px solid ${r.cocReturn >= r.targetReturnPct ? '#1a7a52' : '#9aafbf'};padding:16px 14px;">
            <p style="margin:0 0 6px;font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#9aafbf;font-family:'Courier New',monospace;">Cash-on-Cash</p>
            <p style="margin:0;font-size:22px;font-weight:700;color:${r.cocReturn >= r.targetReturnPct ? '#1a7a52' : '#4a5e72'};font-family:Georgia,serif;line-height:1;">${fmtP(r.cocReturn)}</p>
            <p style="margin:4px 0 0;font-size:10px;color:#9aafbf;">year 1 return</p>
          </div>
        </td>
      </tr>
      <tr>
        <td width="33%" style="padding-right:8px;padding-bottom:12px;">
          <div style="background:#f7f9fb;border:1px solid #e8eef4;border-radius:8px;padding:14px;">
            <p style="margin:0 0 4px;font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#9aafbf;font-family:'Courier New',monospace;">Monthly Mortgage</p>
            <p style="margin:0;font-size:16px;font-weight:600;color:#0b1f3a;font-family:Georgia,serif;">${fmt(r.mortgage)}</p>
          </div>
        </td>
        <td width="33%" style="padding-right:8px;padding-bottom:12px;">
          <div style="background:#f7f9fb;border:1px solid #e8eef4;border-radius:8px;padding:14px;">
            <p style="margin:0 0 4px;font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#9aafbf;font-family:'Courier New',monospace;">Break-Even Rent</p>
            <p style="margin:0;font-size:16px;font-weight:600;color:#0b1f3a;font-family:Georgia,serif;">${fmt(r.breakEvenMonthly)}/mo</p>
          </div>
        </td>
        <td width="33%" style="padding-bottom:12px;">
          <div style="background:#f7f9fb;border:1px solid #e8eef4;border-radius:8px;padding:14px;">
            <p style="margin:0 0 4px;font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#9aafbf;font-family:'Courier New',monospace;">Max Price</p>
            <p style="margin:0;font-size:16px;font-weight:600;color:#0b1f3a;font-family:Georgia,serif;">${fmt(r.maxPrice)}</p>
          </div>
        </td>
      </tr>
    </table>

    <!-- DEAL DETAILS -->
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8eef4;border-radius:8px;overflow:hidden;margin-bottom:24px;">
      <tr style="background:#f7f9fb;"><td colspan="2" style="padding:10px 16px;font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#9aafbf;">Deal Summary</td></tr>
      <tr style="border-top:1px solid #eef2f6;"><td style="padding:10px 16px;font-size:12px;color:#4a5e72;border-bottom:1px solid #eef2f6;">Purchase Price</td><td style="padding:10px 16px;font-size:12px;font-family:'Courier New',monospace;text-align:right;border-bottom:1px solid #eef2f6;">${fmt(parseFloat(d.purchasePrice))}</td></tr>
      <tr><td style="padding:10px 16px;font-size:12px;color:#4a5e72;border-bottom:1px solid #eef2f6;">Down Payment</td><td style="padding:10px 16px;font-size:12px;font-family:'Courier New',monospace;text-align:right;border-bottom:1px solid #eef2f6;">${fmt(r.downPayment)} (${d.downPaymentPct}%)</td></tr>
      <tr><td style="padding:10px 16px;font-size:12px;color:#4a5e72;border-bottom:1px solid #eef2f6;">Loan Amount</td><td style="padding:10px 16px;font-size:12px;font-family:'Courier New',monospace;text-align:right;border-bottom:1px solid #eef2f6;">${fmt(r.loanAmount)}</td></tr>
      <tr><td style="padding:10px 16px;font-size:12px;color:#4a5e72;border-bottom:1px solid #eef2f6;">Monthly Gross Rent</td><td style="padding:10px 16px;font-size:12px;font-family:'Courier New',monospace;text-align:right;border-bottom:1px solid #eef2f6;">${fmt(parseFloat(d.monthlyRent))}/mo</td></tr>
      <tr><td style="padding:10px 16px;font-size:12px;color:#4a5e72;border-bottom:1px solid #eef2f6;">Monthly Expenses (excl. mortgage)</td><td style="padding:10px 16px;font-size:12px;font-family:'Courier New',monospace;text-align:right;border-bottom:1px solid #eef2f6;">${fmt(r.totalMonthlyExpenses)}/mo</td></tr>
      <tr><td style="padding:10px 16px;font-size:12px;color:#4a5e72;border-bottom:1px solid #eef2f6;">Gross Rent Multiplier</td><td style="padding:10px 16px;font-size:12px;font-family:'Courier New',monospace;text-align:right;border-bottom:1px solid #eef2f6;">${r.grm.toFixed(1)}x</td></tr>
      <tr><td style="padding:10px 16px;font-size:12px;color:#4a5e72;">Your Target IRR</td><td style="padding:10px 16px;font-size:12px;font-family:'Courier New',monospace;text-align:right;">${fmtP(r.targetReturnPct)}</td></tr>
    </table>

    ${d.notes ? `<div style="background:#f7f9fb;border:1px solid #e8eef4;border-radius:8px;padding:16px;margin-bottom:24px;">
      <p style="margin:0 0 6px;font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#9aafbf;">Your Notes</p>
      <p style="margin:0;font-size:13px;color:#4a5e72;line-height:1.65;">${d.notes}</p>
    </div>` : ''}

  </td></tr>

  <!-- INTERACTIVE CTA -->
  <tr><td style="background:#0b1f3a;padding:28px 40px;text-align:center;">
    <p style="margin:0 0 6px;font-size:10px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;color:rgba(255,255,255,0.4);">Want to run different scenarios?</p>
    <p style="margin:0 0 20px;font-size:18px;font-weight:600;color:#fff;font-family:Georgia,serif;line-height:1.4;">Adjust your assumptions &amp;<br/>watch the numbers update live</p>
    <a href="${reportUrl}" style="display:inline-block;background:#c9a84c;color:#0b1f3a;padding:13px 32px;border-radius:5px;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;text-decoration:none;">View Interactive Report →</a>
    <p style="margin:14px 0 0;font-size:11px;color:rgba(255,255,255,0.3);">Change rent, expenses, interest rate &amp; more</p>
  </td></tr>

  <!-- PREMIUM -->
  <tr><td style="background:#fefae8;border-left:4px solid #c9a84c;padding:24px 40px;">
    <p style="margin:0 0 6px;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#b8922e;">YieldIQ Premium — Coming Soon</p>
    <p style="margin:0 0 14px;font-size:13px;color:#4a5e72;line-height:1.65;">See how this property compares to your local market. Rent comps, vacancy trends, expense benchmarks, and a personalized hold/sell/refinance signal.</p>
    <a href="https://yieldiq.co" style="display:inline-block;background:#0b1f3a;color:#f4efe6;padding:10px 22px;border-radius:4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;text-decoration:none;">Get Early Access</a>
  </td></tr>

  <!-- FOOTER -->
  <tr><td style="background:#0b1f3a;border-radius:0 0 10px 10px;padding:24px 40px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td><span style="font-family:Georgia,serif;font-size:16px;font-weight:700;color:#fff;">Yield<em style="color:#c9a84c;font-style:italic;">IQ</em></span><p style="margin:5px 0 0;font-size:10px;color:rgba(255,255,255,0.3);">Built for real investors.</p></td>
      <td align="right" style="vertical-align:top;"><p style="margin:0;font-size:10px;color:rgba(255,255,255,0.25);line-height:1.6;">© 2026 YieldIQ<br/>This report is for informational purposes only<br/>and does not constitute financial advice.</p></td>
    </tr></table>
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

    // Build report URL for interactive page
    const reportUrl = buildReportUrl(d);

    // Build and send the email
    const emailHtml = buildEmail(d, results, reportUrl);

    await resend.emails.send({
      from: 'YieldIQ Reports <reports@yieldiq.co>',
      to: d.email,
      subject: `Your YieldIQ Property Report — ${d.address}`,
      html: emailHtml,
    });

    // Also notify yourself
    await resend.emails.send({
      from: 'YieldIQ Reports <reports@yieldiq.co>',
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
