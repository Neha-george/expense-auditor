const fs = require('fs');
let data = fs.readFileSync('supabase_setup.sql', 'utf8');

data = data.replace(/and exists \(\s*select 1 from profiles where id = auth\.uid\(\) and role = 'admin'\s*\)/g, "and get_auth_user_role() = 'admin'");
data = data.replace(/and exists \(\s*select 1 from profiles p2\s*where p2\.id = auth\.uid\(\) and p2\.role = 'admin'\s*\)/g, "and get_auth_user_role() = 'admin'");

fs.writeFileSync('supabase_setup.sql', data);
console.log('Fixed supabase_setup.sql RLS policies');
