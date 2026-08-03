# Distribution Guide — Platform 3/4: Make.com

## What this gives you

A Make.com **Scenario** (their word for a Zap). Make is more flexible than
Zapier for HTTP — you can post a batch of emails in one call and iterate the
results on the other side, all without the "1 task = 1 record" tax Zapier
charges.

## Before you start

- Free Make.com account at https://make.com
- Your Apify `run-sync` URL from Platform 1

---

## Step-by-step: "Verify emails from Google Sheets, log results"

### Step 1 — Sign in and create a scenario

Go to https://make.com → Scenarios → **Create a new scenario**.

### Step 2 — Module 1: Google Sheets — Watch New Rows

- Click the **+** to add a module
- Pick **Google Sheets** → **Watch New Rows**
- Sign in to Google, pick your spreadsheet
- Set "Limit" to 50 rows per run

### Step 3 — Module 2: Iterator (so each row is processed separately OR collect into array)

Option A — pass all rows as an array:
- Module: **Flow Control → Iterator**
- Array: map the `{{columnName}}` from each row into an array

Option B — process one row at a time:
- Module: built-in iterator mode (auto-set when you add one)

### Step 4 — Module 3: HTTP — Make a POST request

- Add a module → **HTTP** → **Make a request**
- **Method:** POST
- **URL:** your Apify `run-sync` URL
- **Headers:** leave default (or add `Content-Type: application/json`)
- **Body type:** JSON
- **Body:**
  ```json
  {
    "emails": {{iterator_array}}
  }
  ```

Make will auto-escape the variable. You'll see something like:
```json
{
  "emails": {{1.array}}
}
```

### Step 5 — Add error handling

HTTP module can fail (timeout, 401). On the HTTP module:
- Click ⚙ → **Settings**
- Set **"Allow storing incomplete executions"** = yes
- **Max number of retries** = 3
- Add an **Error handler** branch that routes to a Slack message: "Verification failed"

### Step 6 — Module 4: Parse the response

Make can't auto-parse JSON, so:
- Add module: **JSON → Parse JSON**
- **JSON string:** insert the HTTP module's response body (it'll be a variable like `{{3.data}}`)
- Make now exposes `{{4.data.items[].email}}`, `{{4.data.items[].overall}}`, etc.

### Step 7 — Module 5: Iterator over results

- Add another **Iterator**
- Array: `{{4.data.items}}`

### Step 8 — Module 6: Log back to Google Sheets (or anywhere)

- Add **Google Sheets → Add a Row**
- Map `{{iterator.email}}`, `{{iterator.overall}}`, etc. to columns

### Step 9 — Schedule it

Click the clock icon at the bottom of the scenario:
- **Run every:** 15 minutes is a good default for free tier
- Free tier allows every 15 min; paid = every 1 min

### Step 10 — Save and turn on

Name it **"Bulk email verifier"** → **Save** → flip the ON switch.

---

## Make vs Zapier — when to pick which

| Use Make.com if... | Use Zapier if... |
|---|---|
| You have a non-technical user who wants to see what each step does visually | You want the bigger app ecosystem (12,000+ apps) |
| You need to handle bigger batches without per-record tax | You need the simplest possible workflow |
| You want tighter error handling and parallel branches | You're already deep in Zapier |
| You're okay with a slightly steeper learning curve | |

---

## Monetization note

Make has **public Apps** (full-blown integrations, approval needed) and **Templates** (free to share, like Zap). For monetization, the same logic applies:

- Real revenue comes from the **Apify runs**
- Make templates drive awareness, Apify makes money
