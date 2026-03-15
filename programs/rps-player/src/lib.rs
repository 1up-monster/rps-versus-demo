//! rps-player — Pinocchio Solana program for Rock Paper Scissors.
//!
//! ## Instructions
//!
//! ### 0x00 — initialize_config
//!
//!   Accounts:
//!     [0] payer          — signer, funds the account
//!     [1] config_pda     — writable, PDA seeded by ["config"]
//!     [2] system_program
//!
//!   Data:
//!     [0x00][game_processor_authority: Pubkey (32 bytes)]
//!
//!   Result: config_pda created, writes:
//!     bytes [0..32] game_processor_authority: Pubkey
//!
//! ### 0x01 — initialize_player
//!
//!   Accounts:
//!     [0] player_wallet  — signer, payer
//!     [1] player_pda     — writable, PDA seeded by ["player", wallet_pubkey]
//!     [2] system_program
//!
//!   Data:
//!     [0x01][initial_elo: u32 LE (4 bytes)]
//!
//!   Result: player_pda created, writes:
//!     bytes [0..4] elo: u32 LE
//!
//! ### 0x02 — update_elo
//!
//!   Accounts:
//!     [0] game_processor — signer
//!     [1] config_pda     — readonly, validates processor authority
//!     [2] player_pda     — writable
//!
//!   Data:
//!     [0x02][new_elo: u32 LE (4 bytes)]
//!
//!   Validates: config_pda[0..32] == game_processor.address()
//!   Result: player_pda[0..4] updated with new_elo
//!
//! ## 1upmonster versus config
//!   eloSource.account.type: "pda"
//!   eloSource.account.seeds: ["player", "{wallet}"]
//!   eloSource.account.programId: <RPS_PROGRAM_ID>
//!   eloSource.offset: 0
//!   eloSource.type: "u32"
//!   eloSource.endian: "little"

#![no_std]

use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    AccountView, Address, ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

pinocchio::program_entrypoint!(process_instruction);
pinocchio::default_allocator!();
pinocchio::nostd_panic_handler!();

const CONFIG_PDA_SIZE: u64 = 32; // game_processor_authority: Pubkey
const PLAYER_PDA_SIZE: u64 = 4;  // elo: u32 LE

fn process_instruction(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    if data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }
    match data[0] {
        0x00 => initialize_config(program_id, accounts, &data[1..]),
        0x01 => initialize_player(program_id, accounts, &data[1..]),
        0x02 => update_elo(accounts, &data[1..]),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// initialize_config — one-time setup by deployer.
/// Creates config_pda and stores the game_processor_authority pubkey.
fn initialize_config(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < 32 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let payer = &accounts[0];
    let config_pda = &accounts[1];
    let authority = &data[0..32];

    // Derive canonical bump for ["config"] PDA
    let (_, bump) = Address::find_program_address(&[b"config"], program_id);
    let bump_seed = [bump];
    let seeds_arr = [Seed::from(b"config"), Seed::from(&bump_seed)];
    let signer = Signer::from(&seeds_arr);

    // Create config_pda via CPI, signed with PDA seeds
    CreateAccount::with_minimum_balance(payer, config_pda, CONFIG_PDA_SIZE, program_id, None)?
        .invoke_signed(&[signer])?;

    // Write game_processor_authority
    let mut buf = config_pda.try_borrow_mut()?;
    buf[0..32].copy_from_slice(authority);

    Ok(())
}

/// initialize_player — called by each player before queuing.
/// Creates player_pda seeded by ["player", wallet_pubkey] and sets initial ELO.
fn initialize_player(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < 4 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let player_wallet = &accounts[0];
    let player_pda = &accounts[1];

    let initial_elo = u32::from_le_bytes(data[0..4].try_into().unwrap());

    // Derive canonical bump for ["player", wallet_pubkey] PDA
    let wallet_key = player_wallet.address(); // &[u8; 32]
    let (_, bump) = Address::find_program_address(&[b"player", wallet_key.as_ref()], program_id);
    let bump_seed = [bump];
    let seeds_arr = [
        Seed::from(b"player"),
        Seed::from(wallet_key.as_ref()),
        Seed::from(&bump_seed),
    ];
    let signer = Signer::from(&seeds_arr);

    // Create player_pda via CPI, signed with PDA seeds
    CreateAccount::with_minimum_balance(
        player_wallet,
        player_pda,
        PLAYER_PDA_SIZE,
        program_id,
        None,
    )?
    .invoke_signed(&[signer])?;

    // Write initial ELO
    let mut buf = player_pda.try_borrow_mut()?;
    buf[0..4].copy_from_slice(&initial_elo.to_le_bytes());

    Ok(())
}

/// update_elo — called exclusively by the game processor after a match.
/// Verifies the signer is the authorized processor, then updates the player's ELO.
fn update_elo(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < 4 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let game_processor = &accounts[0];
    let config_pda = &accounts[1];
    let player_pda = &accounts[2];

    let new_elo = u32::from_le_bytes(data[0..4].try_into().unwrap());

    // Verify game_processor is the authorized authority stored in config_pda
    let config_data = config_pda.try_borrow()?;
    if config_data.len() < 32 {
        return Err(ProgramError::InvalidAccountData);
    }
    let stored_authority: &[u8] = &config_data[0..32];
    let processor_key: &[u8] = game_processor.address().as_ref();
    if stored_authority != processor_key {
        return Err(ProgramError::InvalidAccountData);
    }

    // Update player ELO in-place (account is already the right size)
    let mut player_data = player_pda.try_borrow_mut()?;
    player_data[0..4].copy_from_slice(&new_elo.to_le_bytes());

    Ok(())
}
