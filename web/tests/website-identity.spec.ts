import {test,expect} from '@playwright/test';
const owner='00000000-0000-4000-8000-000000000001';
const other='00000000-0000-4000-8000-000000000002';
function session(id=owner,authenticated=true) {
  return {authenticated,enabled:true,method:'oidc',environment:'test',csrf:'a'.repeat(64),
    account:{id,username:'fixture',display_name:'Fixture account',timezone:'America/New_York',administrator:false},
    security_url:'https://identity.invalid/account/'};
}
for (const mobile of [false,true]) {
  test(`compact OIDC entry has no password collection (${mobile?'mobile':'desktop'})`,async({page},testInfo)=>{
    if(mobile) await page.setViewportSize({width:390,height:844});
    await page.route('**/api/auth/session',route=>route.fulfill({json:session(owner,false)}));
    await page.goto('/?auth_error=sign_in_failed');
    await expect(page.getByRole('heading',{name:'GTD',exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'Sign in',exact:true})).toBeVisible();
    await expect(page.getByLabel('Stay signed in')).toBeChecked();
    await expect(page.locator('input[type=password]')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveText('Sign-in was not completed. Please try again.');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
    await page.screenshot({path:testInfo.outputPath('oidc-login.png'),fullPage:true});
  });
}
for (const switched of [false,true]) {
  test(`expired sign-in ${switched?'rejects another account':'retains same-account draft without replay'}`,async({page,context,baseURL},testInfo)=>{
    let active=true,id=owner,captures=0;
    await context.route('**/api/auth/session',route=>route.fulfill({json:session(id,active)}));
    await page.route('**/api/tools/capture_item',route=>{
      captures++; active=false;
      const headers=route.request().headers();
      expect(headers['x-gtd-account']).toBe(owner);
      expect(headers['x-gtd-csrf']).toBe('a'.repeat(64));
      return route.fulfill({status:401,json:{code:'authentication_required',message:'Sign in to continue'}});
    });
    await context.route('**/api/auth/login',route=>{
      expect(route.request().postDataJSON().return_to).toBe('/?gtd_sign_in=complete');
      return route.fulfill({json:{authorization_url:'https://identity.invalid/disposable-login'}});
    });
    // Protocol/browser simulator only: no provider sign-in or live model prompt.
    await context.route('https://identity.invalid/disposable-login',route=>{
      active=true;id=switched?other:owner;
      // WebKit cannot fulfill a 302 through its interceptor. Navigate from a
      // synthetic provider page to the same normal callback landing page.
      return route.fulfill({contentType:'text/html',body:`<!doctype html><script>location.replace(${JSON.stringify(baseURL+'/?gtd_sign_in=complete')})</script>`});
    });
    await page.goto('/');
    await page.getByRole('button',{name:'Add task',exact:true}).click();
    await page.getByRole('textbox',{name:'Add to inbox',exact:true}).fill('Keep this unsaved fixture');
    await page.getByRole('button',{name:'Capture task',exact:true}).click();
    const login=page.getByRole('dialog',{name:'Sign in to GTD'});
    await expect(login).toBeVisible();
    await login.getByRole('button',{name:'Sign in',exact:true}).click();
    if(switched) {
      await expect(page.getByText('This session has ended.',{exact:true})).toBeVisible();
      await expect(page.getByRole('button',{name:'Reopen',exact:true})).toBeVisible();
      await expect(page.getByRole('textbox',{name:'Add to inbox',exact:true})).not.toBeVisible();
    } else {
      await expect(login).not.toBeVisible();
      await expect(page.getByRole('textbox',{name:'Add to inbox',exact:true})).toHaveValue('Keep this unsaved fixture');
    }
    expect(captures).toBe(1);
    await page.screenshot({path:testInfo.outputPath('resumed.png'),fullPage:true});
  });
}
