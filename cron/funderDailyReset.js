import cron from 'node-cron';
import { supabase } from '../config/supabase.js';

// Run this check every hour on the hour
cron.schedule('0 * * * *', async () => {
  
  // 1. Fetch funders whose reset_time has passed
  const { data: funders, error: fetchError } = await supabase
    .from('funders')
    .select('id, reset_time')
    .lte('reset_time', new Date().toISOString());
    
  if (fetchError) {
    console.error('[CRON] Error fetching funders for reset:', fetchError);
    return;
  }
  
  if (!funders || funders.length === 0) return;
  
  for (const funder of funders) {
    
    // 2. Find all packages under this funder
    const { data: packages } = await supabase
      .from('package')
      .select('id')
      .eq('funder_id', funder.id);
      
    if (packages && packages.length > 0) {
      const packageIds = packages.map(p => p.id);
      
      // Find all funder_accounts linked to those packages
      const { data: funderAccounts } = await supabase
        .from('funder_account')
        .select('id')
        .in('package_id', packageIds);
        
      if (funderAccounts && funderAccounts.length > 0) {
        const faIds = funderAccounts.map(fa => fa.id);
        
        // Fetch all trading_accounts to update their baseline equity
        const { data: tradingAccounts } = await supabase
          .from('trading_accounts')
          .select('id, live_equity')
          .in('funder_account_id', faIds);
          
        if (tradingAccounts) {
          // Update each account: daily_starting_equity matches current equity, and daily_pnl goes to 0
          for (const ta of tradingAccounts) {
            await supabase
              .from('trading_accounts')
              .update({
                daily_starting_equity: ta.live_equity || 0,
                daily_pnl: 0
              })
              .eq('id', ta.id);
          }
        }
      }
    }
    
    // 3. Increment the funder's reset_time to the next day
    const nextReset = new Date(funder.reset_time);
    nextReset.setUTCDate(nextReset.getUTCDate() + 1); // Add 1 day
    
    // Fast-forward in case the script was offline for multiple days
    while (nextReset <= new Date()) {
      nextReset.setUTCDate(nextReset.getUTCDate() + 1);
    }
    
    await supabase
      .from('funders')
      .update({ reset_time: nextReset.toISOString() })
      .eq('id', funder.id);
  }
});
