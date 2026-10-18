import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Error: VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY not found in .env');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkSignals() {
    console.log('🚀 Fetching the latest 5 signals from Supabase...');

    const { data, error } = await supabase
        .from('reports')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(5);

    if (error) {
        console.error('❌ Database error:', error.message);
        return;
    }

    if (!data || data.length === 0) {
        console.log('ℹ️ No signals found in the database yet.');
        return;
    }

    console.log(`✅ Success! Found ${data.length} recent reports.\n`);

    data.forEach((report, index) => {
        console.log(`--- [Report ${index + 1}] ---`);
        console.log(`📍 Website: ${report.website_url}`);
        console.log(`🕒 Created: ${new Date(report.created_at).toLocaleString()}`);
        console.log(`🔍 Strategic Context:`);
        console.log(`   - Industry: ${report.context?.industry || 'N/A'}`);
        console.log(`   - Region: ${report.context?.operating_geography || 'N/A'}`);

        if (report.signals && Array.isArray(report.signals)) {
            console.log(`📡 Signals (${report.signals.length} total):`);
            report.signals.slice(0, 3).forEach((sig, sIdx) => {
                console.log(`   ${sIdx + 1}. [${sig.type || 'N/A'}] ${sig.headline || sig.title || 'No Headline'}`);
                console.log(`      "${sig.summary?.substring(0, 100)}..."`);
            });
            if (report.signals.length > 3) console.log(`   ...and ${report.signals.length - 3} more signals.`);
        } else {
            console.log('📡 Signals: None or invalid format.');
        }
        console.log('\n');
    });
}

checkSignals();
