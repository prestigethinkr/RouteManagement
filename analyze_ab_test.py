import pandas as pd
import glob
import os
import numpy as np

# 1. Load Data
legacy_file = 'TEST DATA/TOOLS HAVERSINE RESULT.xlsx'
new_files = glob.glob('logs/RoutingResult_ORTools (Matrix Constraints)_Ritase*.xlsx')

print("Loading Legacy Data...")
df_legacy = pd.read_excel(legacy_file, sheet_name='Sheet1')
df_legacy['RECAPNO_CARNO'] = df_legacy['RECAPNO'].astype(str) + '_' + df_legacy['CARNO'].astype(str)

print("Loading New Data...")
df_new_inv_list = []
df_new_fleet_list = []
for idx, f in enumerate(new_files):
    df_inv = pd.read_excel(f, sheet_name='Invoice Detail')
    df_inv['RITASE_ID'] = idx + 1
    df_new_inv_list.append(df_inv)
    
    df_fleet = pd.read_excel(f, sheet_name='Fleet Summary')
    df_fleet['RITASE_ID'] = idx + 1
    df_new_fleet_list.append(df_fleet)

df_new_inv = pd.concat(df_new_inv_list, ignore_index=True)
df_new_fleet = pd.concat(df_new_fleet_list, ignore_index=True)

# Join new invoices with legacy to get geographical and grouping metadata
# We assume INVNO is unique
metadata = df_legacy[['INVNO', 'KECAMATAN', 'KELURAHAN', 'GROUPPAYER', 'GROUPKECAMATAN', 'GROUPARMADA']].drop_duplicates('INVNO')
df_new_inv = df_new_inv.merge(metadata, on='INVNO', how='left')

# --- 1. Fleet Utilization & Payload Efficiency (EPE) ---
# Legacy EPE
# Max (SUM(INVTONASE) / CARTONASE, SUM(INVKUBIKASE) / CARKUBIKASI) * 100%
legacy_trip_stats = df_legacy.groupby('RECAPNO_CARNO').agg({
    'INVTONASE': 'sum',
    'INVKUBIKASE': 'sum',
    'CARTONASE': 'first',
    'CARKUBIKASI': 'first',
    'INVNO': 'count'
})
legacy_trip_stats['EPE'] = np.maximum(
    legacy_trip_stats['INVTONASE'] / legacy_trip_stats['CARTONASE'],
    legacy_trip_stats['INVKUBIKASE'] / legacy_trip_stats['CARKUBIKASI']
) * 100
legacy_epe_avg = legacy_trip_stats['EPE'].mean()
legacy_fleet_count = legacy_trip_stats.shape[0]

# New System EPE is already calculated in Fleet Summary as '% MAX EPE'
# Or we can recalculate: Max(TONASE / STD TONASE, KUBIKASI / STD KUBIK) * 100
df_new_fleet['EPE'] = df_new_fleet['% MAX EPE'] * 100 if df_new_fleet['% MAX EPE'].mean() <= 1.0 else df_new_fleet['% MAX EPE']
new_epe_avg = df_new_fleet['EPE'].mean()
new_fleet_count = df_new_fleet.shape[0]

print(f"\n--- 1. Fleet Utilization ---")
print(f"Legacy Avg EPE: {legacy_epe_avg:.2f}% | Total Fleet/Trips Used: {legacy_fleet_count}")
print(f"New Avg EPE: {new_epe_avg:.2f}% | Total Fleet/Trips Used: {new_fleet_count}")
print(f"Vehicle Saved: {legacy_fleet_count - new_fleet_count}")

# --- 2. Spatial Density & Clustering (Geographic Spread) ---
# Legacy: Unique KECAMATAN and KELURAHAN per RECAPNO_CARNO
legacy_spatial = df_legacy.groupby('RECAPNO_CARNO').agg({
    'KECAMATAN': 'nunique',
    'KELURAHAN': 'nunique'
})
legacy_avg_kec = legacy_spatial['KECAMATAN'].mean()
legacy_avg_kel = legacy_spatial['KELURAHAN'].mean()

# New: Unique KECAMATAN and KELURAHAN per NOKEND_RITASE
df_new_inv['NOKEND_RITASE'] = df_new_inv['NOKEND'].astype(str) + '_' + df_new_inv['RITASE_ID'].astype(str)
new_spatial = df_new_inv.groupby('NOKEND_RITASE').agg({
    'KECAMATAN': 'nunique',
    'KELURAHAN': 'nunique'
})
new_avg_kec = new_spatial['KECAMATAN'].mean()
new_avg_kel = new_spatial['KELURAHAN'].mean()

print(f"\n--- 2. Spatial Density ---")
print(f"Legacy Avg Kecamatan per Trip: {legacy_avg_kec:.2f} | Avg Kelurahan per Trip: {legacy_avg_kel:.2f}")
print(f"New Avg Kecamatan per Trip: {new_avg_kec:.2f} | Avg Kelurahan per Trip: {new_avg_kel:.2f}")

# --- 4. Constraint Adherence (GroupPayer & Zoning) ---
# GroupPayer: Are there any GroupPayer split across multiple trips?
legacy_grouppayer_split = df_legacy.groupby('GROUPPAYER')['RECAPNO_CARNO'].nunique()
legacy_split_count = (legacy_grouppayer_split > 1).sum()

new_grouppayer_split = df_new_inv.groupby('GROUPPAYER')['NOKEND_RITASE'].nunique()
new_split_count = (new_grouppayer_split > 1).sum()

print(f"\n--- 4. Constraint Adherence ---")
print(f"Legacy GroupPayer Splitting: {legacy_split_count} groups split")
print(f"New GroupPayer Splitting: {new_split_count} groups split")

# If you need zoning compliance, we can check if GROUPARMADA matches JNSKEND roughly, 
# but the prompt mainly asks if it successfully respected the GroupPayer atomicity.

