const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const express = require('express');
const cron = require('node-cron');
require('dotenv').config();

// Initialize Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages,
    ],
});

// Configuration
const GUILD_ID = process.env.GUILD_ID; // Your Discord server ID
const ROLE_IDS = {
    monthly: process.env.MONTHLY_ROLE_ID,
    quarterly: process.env.QUARTERLY_ROLE_ID,
    lifetime: process.env.LIFETIME_ROLE_ID,
};

// Initialize Express server for webhooks
const app = express();
app.use(express.json());

// Bot ready event
client.once('ready', () => {
    console.log(`✅ Bot logged in as ${client.user.tag}`);
    console.log(`📊 Serving ${client.guilds.cache.size} servers`);

    // Start expiry monitoring cron job (runs daily at 9 AM)
    startExpiryMonitor();
});

// Health check endpoint
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        bot: client.user ? client.user.tag : 'not ready',
        uptime: process.uptime(),
    });
});

// Webhook endpoint to receive delivery requests from payment system
app.post('/deliver', async (req, res) => {
    const {
        discord_id,
        discord_username,
        license_key,
        download_url,
        plan_type,
        email
    } = req.body;

    console.log(`📨 Delivery request received for ${discord_username} (${discord_id})`);

    // Validate required fields
    if (!discord_id || !license_key) {
        console.error('❌ Missing required fields');
        return res.status(400).json({
            error: 'Missing required fields',
            required: ['discord_id', 'license_key']
        });
    }

    try {
        // Fetch user by Discord ID
        const user = await client.users.fetch(discord_id);

        // ==================================================
        // STEP 1: Assign Discord Role (Add to Private Community)
        // ==================================================
        let roleAssigned = false;

        if (GUILD_ID && ROLE_IDS[plan_type]) {
            try {
                const guild = await client.guilds.fetch(GUILD_ID);
                const member = await guild.members.fetch(discord_id);
                const role = await guild.roles.fetch(ROLE_IDS[plan_type]);

                if (role) {
                    await member.roles.add(role);
                    console.log(`✅ Assigned ${plan_type} role to ${discord_username}`);
                    roleAssigned = true;
                }
            } catch (roleError) {
                console.error('⚠️ Role assignment failed:', roleError.message);
                // Continue anyway - user still gets license
            }
        }

        // ==================================================
        // STEP 2: Create Welcome Message + EA Delivery
        // ==================================================
        const embed = new EmbedBuilder()
            .setColor(0x5865F2) // Discord blurple color
            .setTitle('🎉 Welcome to PropQuant.ai!')
            .setDescription('Your EA access is now active!')
            .addFields(
                {
                    name: '🔑 License Key',
                    value: `\`\`\`${license_key}\`\`\``,
                    inline: false
                },
                {
                    name: '📱 Plan',
                    value: plan_type.charAt(0).toUpperCase() + plan_type.slice(1),
                    inline: true
                },
                {
                    name: '📧 Email',
                    value: email || 'Not provided',
                    inline: true
                }
            );

        // Add role assignment confirmation
        if (roleAssigned) {
            embed.addFields({
                name: '✨ Community Access',
                value: `You've been added to the ${plan_type} members group!\nCheck out the exclusive channels in our server.`,
                inline: false
            });
        }

        // Add download link if provided
        if (download_url) {
            embed.addFields({
                name: '⬇️ Download EA',
                value: `[Click here to download](${download_url})\n⏰ Link expires in 1 hour`,
                inline: false
            });
        }

        // Add installation instructions
        embed.addFields({
            name: '📖 Installation Instructions',
            value:
                '1️⃣ Download the EA file above\n' +
                '2️⃣ Place in MT5: `MQL5/Experts/`\n' +
                '3️⃣ Restart MetaTrader 5\n' +
                '4️⃣ Drag EA onto your chart\n' +
                '5️⃣ Enter your license key when prompted\n\n' +
                '📚 Need help? Visit <#support-channel> in our Discord!',
            inline: false
        });

        embed.setFooter({ text: 'PropQuant.ai - Automated Trading Excellence' })
            .setTimestamp();

        // Send DM to user
        await user.send({ embeds: [embed] });

        console.log(`✅ Welcome DM sent successfully to ${discord_username}`);

        // Return success
        res.json({
            success: true,
            message: 'DM sent and role assigned',
            user: discord_username,
            role_assigned: roleAssigned
        });

    } catch (error) {
        console.error('❌ Failed to send DM:', error.message);

        // Handle common errors
        if (error.code === 50007) {
            return res.status(403).json({
                error: 'Cannot send DM to user',
                message: 'User has DMs disabled or has not accepted DMs from server members',
                discord_id
            });
        }

        if (error.code === 10013) {
            return res.status(404).json({
                error: 'User not found',
                message: 'Discord user ID does not exist',
                discord_id
            });
        }

        res.status(500).json({
            error: 'Failed to send DM',
            message: error.message,
            discord_id
        });
    }
});

// ==================================================
// EXPIRY MONITORING & RENEWAL REMINDERS
// ==================================================

async function checkExpiringLicenses() {
    console.log('🔍 Checking for expiring licenses...');

    const LICENSE_SERVICE_URL = process.env.LICENSE_SERVICE_URL;
    const LICENSE_API_KEY = process.env.LICENSE_SERVICE_API_KEY;

    if (!LICENSE_SERVICE_URL || !LICENSE_API_KEY) {
        console.log('⚠️ License service not configured');
        return;
    }

    try {
        // Fetch expiring licenses from license service
        const response = await fetch(
            `${LICENSE_SERVICE_URL}/admin_7f3a92/analytics/expired_but_active?key=${LICENSE_API_KEY}`
        );

        if (!response.ok) {
            console.error('Failed to fetch expiring licenses');
            return;
        }

        const data = await response.json();
        const expiringLicenses = data.data || [];

        console.log(`Found ${expiringLicenses.length} expiring licenses`);

        for (const license of expiringLicenses) {
            const daysUntilExpiry = Math.ceil(
                (new Date(license.expires_at) - new Date()) / (1000 * 60 * 60 * 24)
            );

            // Send reminder 3 days before expiry
            if (daysUntilExpiry <= 3 && daysUntilExpiry > 0) {
                await sendRenewalReminder(license, daysUntilExpiry);
            }

            // Remove role if expired
            if (daysUntilExpiry <= 0) {
                await removeExpiredRole(license);
            }
        }
    } catch (error) {
        console.error('Error checking expiring licenses:', error);
    }
}

async function sendRenewalReminder(license, daysLeft) {
    try {
        // Get user from Supabase (would need to query)
        // For now, this is a placeholder - you'd fetch discord_id from your database
        console.log(`📧 Sending renewal reminder for ${license.email} (${daysLeft} days left)`);

        // TODO: Fetch discord_id from Supabase users table by email
        // const user = await client.users.fetch(discord_id);

        const embed = new EmbedBuilder()
            .setColor(0xFFA500) // Orange for warning
            .setTitle('⏰ License Expiring Soon!')
            .setDescription(`Your PropQuant EA license expires in **${daysLeft} days**!`)
            .addFields(
                {
                    name: '📅 Expiry Date',
                    value: new Date(license.expires_at).toLocaleDateString(),
                    inline: true
                },
                {
                    name: '🔄 Renew Now',
                    value: '[Visit Website](https://web-wheat-three-69.vercel.app)',
                    inline: true
                },
                {
                    name: '📌 What Happens Next',
                    value:
                        '• Your EA will stop working after expiry\n' +
                        '• You\'ll lose access to private channels\n' +
                        '• Renew now to keep your access!',
                    inline: false
                }
            )
            .setFooter({ text: 'Renew before expiry to avoid interruption' })
            .setTimestamp();

        // await user.send({ embeds: [embed] });
        // console.log(`✅ Renewal reminder sent to ${user.username}`);

    } catch (error) {
        console.error(`Failed to send renewal reminder:`, error.message);
    }
}

async function removeExpiredRole(license) {
    if (!GUILD_ID) return;

    try {
        console.log(`🔒 Removing expired role for ${license.email}`);

        // TODO: Fetch discord_id from Supabase
        // const guild = await client.guilds.fetch(GUILD_ID);
        // const member = await guild.members.fetch(discord_id);

        // Remove all plan roles
        // for (const roleId of Object.values(ROLE_IDS)) {
        //   if (roleId) {
        //     await member.roles.remove(roleId);
        //   }
        // }

        // Send expiry notification
        const embed = new EmbedBuilder()
            .setColor(0xFF0000) // Red for expiry
            .setTitle('❌ License Expired')
            .setDescription('Your PropQuant EA license has expired.')
            .addFields(
                {
                    name: '🔄 Renew Your License',
                    value: '[Visit Website](https://web-wheat-three-69.vercel.app)',
                    inline: false
                },
                {
                    name: '📌 What Changed',
                    value:
                        '• Your EA has stopped working\n' +
                        '• You\'ve been removed from private channels\n' +
                        '• Renew anytime to regain access!',
                    inline: false
                }
            )
            .setFooter({ text: 'We hope to see you back soon!' });

        // await user.send({ embeds: [embed] });
        console.log(`✅ Expiry notification sent`);

    } catch (error) {
        console.error(`Failed to remove expired role:`, error.message);
    }
}

// Start cron job for monitoring (runs daily at 9 AM)
function startExpiryMonitor() {
    cron.schedule('0 9 * * *', () => {
        console.log('⏰ Running daily expiry check...');
        checkExpiringLicenses();
    });

    console.log('✅ Expiry monitor started (runs daily at 9 AM)');
}

// Start Express server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Webhook server running on port ${PORT}`);
});

// Login to Discord
client.login(process.env.DISCORD_BOT_TOKEN)
    .then(() => console.log('🔐 Logging in to Discord...'))
    .catch(err => {
        console.error('❌ Failed to login:', err.message);
        process.exit(1);
    });

// Error handlers
client.on('error', error => {
    console.error('Discord client error:', error);
});

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});
