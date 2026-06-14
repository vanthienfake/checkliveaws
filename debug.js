// Debug script - Test full Root user flow
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const TEST_EMAIL = 'test_nonexistent_email_12345@gmail.com'; // Should be DEAD

(async () => {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox', 
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1366,768'
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  try {
    // Step 1: Navigate
    console.log('\n=== Step 1: Navigate to AWS Console ===');
    await page.goto('https://console.aws.amazon.com/console/home', { 
      waitUntil: 'networkidle2', timeout: 60000 
    });
    await new Promise(r => setTimeout(r, 3000));
    
    console.log('URL:', page.url().substring(0, 80));
    
    // Step 2: Check if on IAM form
    console.log('\n=== Step 2: Check IAM form ===');
    const hasIAM = await page.evaluate(() => ({
      hasAccount: !!document.querySelector('#account'),
      hasUsername: !!document.querySelector('#username'),
      hasPassword: !!document.querySelector('#password'),
      hasRootBtn: !!document.querySelector('#root_account_signin'),
    }));
    console.log('IAM form elements:', JSON.stringify(hasIAM));

    // Step 3: Click Root user button
    if (hasIAM.hasRootBtn) {
      console.log('\n=== Step 3: Click Root user button ===');
      await page.click('#root_account_signin');
      await new Promise(r => setTimeout(r, 2000));
      
      try {
        await page.waitForSelector('#resolving_input', { visible: true, timeout: 15000 });
        console.log('✓ #resolving_input found!');
      } catch(e) {
        console.log('✗ #resolving_input NOT found after wait');
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    
    // Step 4: Verify Root user form
    console.log('\n=== Step 4: Verify Root user form ===');
    const postSwitch = await page.evaluate(() => ({
      url: window.location.href.substring(0, 80),
      hasAccount: !!document.querySelector('#account'),
      hasUsername: !!document.querySelector('#username'),
      hasResolvingInput: !!document.querySelector('#resolving_input'),
      hasNextButton: !!document.querySelector('#next_button'),
      visibleInputs: Array.from(document.querySelectorAll('input'))
        .filter(i => i.offsetParent !== null)
        .map(i => ({ id: i.id, type: i.type })),
      bodyText: document.body.innerText.substring(0, 300),
    }));
    console.log('Post-switch state:', JSON.stringify(postSwitch, null, 2));

    // Step 5: Type email and submit
    if (postSwitch.hasResolvingInput) {
      console.log('\n=== Step 5: Type email and submit ===');
      const emailInput = await page.$('#resolving_input');
      await emailInput.click({ clickCount: 3 });
      await new Promise(r => setTimeout(r, 200));
      await emailInput.type(TEST_EMAIL, { delay: 30 });
      console.log(`Typed: ${TEST_EMAIL}`);
      
      await new Promise(r => setTimeout(r, 500));
      
      const nextBtn = await page.$('#next_button');
      if (nextBtn) {
        await nextBtn.click();
        console.log('Clicked #next_button');
      } else {
        await page.keyboard.press('Enter');
        console.log('Pressed Enter');
      }
      
      // Step 6: Wait for response
      console.log('\n=== Step 6: Wait for response ===');
      try {
        await Promise.race([
          page.waitForNavigation({ timeout: 20000, waitUntil: 'networkidle2' }).catch(() => {}),
          page.waitForSelector('[role="alert"]', { visible: true, timeout: 20000 }).catch(() => {}),
          page.waitForSelector('#password_input', { visible: true, timeout: 20000 }).catch(() => {}),
          new Promise(r => setTimeout(r, 15000))
        ]);
      } catch(e) {
        console.log('Wait error:', e.message);
      }
      
      await new Promise(r => setTimeout(r, 3000));
      
      // Step 7: Check result
      console.log('\n=== Step 7: Check result ===');
      const result = await page.evaluate(() => {
        const text = (document.body.innerText || '').toLowerCase();
        const pwInputs = Array.from(document.querySelectorAll('input[type="password"]'))
          .filter(i => i.offsetParent !== null);
        const alerts = Array.from(document.querySelectorAll('[role="alert"]'))
          .map(el => el.textContent.trim());
        
        return {
          url: window.location.href.substring(0, 80),
          bodyTextPreview: text.substring(0, 500),
          visiblePasswordFields: pwInputs.length,
          passwordFieldIds: pwInputs.map(p => p.id),
          hasAccount: !!document.querySelector('#account'),
          hasUsername: !!document.querySelector('#username'),
          hasResolvingInput: !!document.querySelector('#resolving_input'),
          alerts: alerts,
          hasDeadText: text.includes('does not exist') || text.includes('try again or create'),
          hasLiveText: text.includes('enter the password for'),
        };
      });
      
      console.log('Result:', JSON.stringify(result, null, 2));
      
      if (result.hasLiveText && result.visiblePasswordFields > 0) {
        console.log('\n>>> RESULT: LIVE <<<');
      } else if (result.hasDeadText) {
        console.log('\n>>> RESULT: DEAD <<<');
      } else if (result.alerts.length > 0) {
        console.log('\n>>> RESULT: DEAD (alert) <<<');
        console.log('Alert text:', result.alerts.join(' | '));
      } else {
        console.log('\n>>> RESULT: UNKNOWN <<<');
      }
    } else {
      console.log('ERROR: Root user form not loaded!');
    }
    
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await browser.close();
    console.log('\nDone!');
  }
})();
