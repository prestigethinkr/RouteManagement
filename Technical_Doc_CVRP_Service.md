# Technical Documentation: `cvrp_service.py`

Dokumen ini berisi penjelasan teknis mendalam mengenai alur data, arsitektur, dan fungsi-fungsi utama yang ada di dalam `cvrp_service.py`. Layanan ini bertanggung jawab atas penyelesaian Capacitated Vehicle Routing Problem (CVRP) menggunakan **Google OR-Tools** dan integrasi **OSRM** (Open Source Routing Machine).

---

## 1. Arsitektur & Alur Data (Data Flow)

Berikut adalah *flowchart* yang menggambarkan perjalanan data sejak *request* diterima hingga *response* (dan Excel) dikembalikan ke frontend.

```mermaid
flowchart TD
    subgraph Data Ingestion
        A([API Request JSON]) --> B(filter_outlets_by_max_vehicle_capacity)
        B -- "Remove Dummy/Huge Orders" --> C(group_by_payer)
    end

    subgraph Preprocessing
        C -- "Consolidate Same Location" --> D(split_large_invoices_atomic)
        D -- "Split if > Max Vehicle" --> E(get_osrm_table_matrix)
    end

    subgraph Core Optimization (OR-Tools)
        E -- "Distance & Duration Matrix" --> F(Routing Index Manager)
        F --> G(Routing Model Configuration)
        G -- "Add Capacity & Time Constraints" --> H[Solve: search_parameters]
        H --> I(Extract Initial Routes)
    end

    subgraph Post-Processing & Guardrails
        I --> J(Enforce Split Constraint / All-or-Nothing)
        J -- "Revoke Partial Splits" --> K(Multi-Trip EPE Pruning)
        K -- "Strip low utilization routes" --> L(Cross-District Sweeper)
        L -- "Fit remaining into slack capacity" --> M(Auto-TSP Polisher)
        M -- "Natural looping sequence" --> N(Final Route Assembly)
    end

    subgraph Output Generation
        N --> O(generate_excel_summary)
        N --> P([API Response JSON])
    end
```

---

## 2. Struktur Modul & Fungsi Utama

Kode di dalam `cvrp_service.py` berjalan secara sekuensial (berurutan) melalui fungsi-fungsi utama berikut:

### A. Preprocessing Data
Bagian ini mempersiapkan dan membersihkan data sebelum dilempar ke *solver* matematis.

- **`filter_outlets_by_max_vehicle_capacity(outlets, vehicles)`**
  Mencari kapasitas truk terbesar di cabang tersebut. Jika ada pesanan (faktur) tunggal yang besarnya melebihi $3 \times$ lipat dari truk terbesar, faktur tersebut dianggap *anomaly/dummy* dan otomatis didrop (dimasukkan ke daftar *unassigned* dengan alasan `EXCEEDS_MAX_CAPACITY`).

- **`group_by_payer(outlets)`**
  Berfungsi menyatukan beberapa objek outlet yang memiliki alamat, nama toko, atau ID *GroupPayer* yang sama menjadi satu **Kesatuan Atomik**. Hal ini mengurangi jumlah *node* (titik) yang harus dihitung OR-Tools, mempercepat kalkulasi, dan mencegah 2 truk datang ke 1 toko yang sama.

- **`split_large_invoices_atomic(outlets, max_m3, max_kg)`**
  Apabila ada satu toko/GroupPayer yang pesanannya sangat besar hingga melebihi satu truk terbesar sekalipun, fungsi ini memecahnya menjadi beberapa pesanan parsial (`_SPLIT_1`, `_SPLIT_2`, dst.) agar logis untuk didistribusikan ke beberapa truk.

### B. Matrix & Distance
- **`get_osrm_table_matrix(coords)`**
  Membuat *request* asinkron ke server OSRM untuk mendapatkan *Distance Matrix* (jarak jalan riil dalam meter) dan *Duration Matrix* (waktu tempuh riil dalam detik). Fungsi ini mendukung teknik *batching* atau *chunking* jika jumlah koordinat terlalu banyak.

### C. Core Solver (OR-Tools)
Fungsi-fungsi ini adalah pembungkus dari pustaka `ortools.constraint_solver.pywrapcp`.

- **`create_data_model(...)`**
  Mengonversi format list Python ke format *array/matrix* yang dipahami oleh OR-Tools. Terdiri dari *distance_matrix*, *time_matrix*, *demands_m3*, *demands_kg*, dll.

- **`solve_zone_cvrp_standalone(...)`** & **`solve_global_cvrp(...)`**
  Ini adalah fungsi kalkulasi utama. Langkah yang terjadi di dalamnya:
  1. Inisialisasi `pywrapcp.RoutingIndexManager` dan `pywrapcp.RoutingModel`.
  2. Mendaftarkan fungsi *callback* untuk Jarak, Waktu, Dimensi Berat (KG), dan Dimensi Volume (M3).
  3. Menambahkan *Capacity Constraints* (batasan berat dan volume tiap armada).
  4. Menambahkan batasan waktu maksimum supir (*Time Limit Constraint*).
  5. Menjalankan *solver* dengan heuristik `PATH_CHEAPEST_ARC` atau parameter pencarian lainnya.
  6. Membaca hasil rute dari *solution node*.

### D. Post-Processing & Guardrails
Ini adalah fase penyempurnaan di mana logika bisnis logistik disuntikkan setelah rute dasar terbentuk.

- **Split Constraint (All-or-Nothing)**:  
  (*Inline logic* saat ekstrak hasil). Mengecek seluruh toko yang sempat dipecah (*split*). Jika dari 3 bagian, hanya 2 yang mendapat truk dan 1 tidak mendapat truk, maka 2 bagian tadi dicabut (*revoke*) dari truknya dan dikembalikan ke antrean *unassigned*. Hal ini menjamin tidak ada faktur parsial.

- **Multi-Trip EPE Pruning** *(Effective Payload Efficiency)*:  
  Mengevaluasi utilitas volume & tonase tiap rute. Jika rute tersebut berstatus *Trip 2* atau *Trip 3* (ritase lanjutan) namun utilisasinya (EPE) berada di bawah ambang batas (misal $< 50\%$), maka rute tersebut dibubarkan (*pruned*) agar armada tidak jalan kosong/rugi.

- **Cross-District Sweeper**:  
  Setelah rute selesai, seringkali ada truk yang masih memiliki sisa ruang (misal sisa 2 M3). Sweeper akan mencoba mengiterasi toko-toko yang belum mendapat mobil (Unassigned Outlets) dan mencocokkannya ke dalam truk-truk bersisa tersebut, tanpa merusak konfigurasi rute awal.

- **Auto-TSP Polisher**:  
  Jika sebuah rute memiliki banyak perhentian (contoh: $> 10$ titik), urutannya mungkin sedikit tumpang tindih secara heuristik. *Polisher* akan mengekstrak titik-titik tersebut dan menjalankan *Traveling Salesperson Problem (TSP)* sekali lagi secara spesifik untuk rute itu saja guna memastikan pola perjalanan memutar (*looping*) yang mulus tanpa persilangan.

### E. Output Generation
- **`generate_excel_summary(...)`**
  Fungsi ini mem-parsing hasil rute final (baik yang berhasil ditugaskan maupun yang *unassigned*) menggunakan library `openpyxl` atau Pandas, menghasilkan file `.xlsx` untuk diunduh langsung oleh user dari antarmuka web. File ini memuat tab Ringkasan, Detail Rute per Kendaraan, dan Daftar Outlet Gagal (*Unassigned*).

---

## 3. Catatan Pengembangan (Dev Notes)
1. **Asynchronous Processing**: Sistem dapat menggunakan *Server-Sent Events (SSE)* / `yield` generator untuk melakukan *streaming logs* secara real-time ke UI frontend agar proses kalkulasi yang berat (bisa sampai $> 1$ menit) tidak terkena *timeout* oleh *Reverse Proxy*.
2. **Determinism**: OR-Tools berjalan dengan setelan *random seed* khusus jika hasil yang berulang (konsisten) diperlukan setiap kali tombol ditekan dengan data yang sama persis.
3. **Koordinat Depot**: Koordinat awal selalu berada di Index 0 pada matriks jarak. Pastikan koordinat depo disuntikkan secara tepat ke dalam struktur `outlets` sebelum iterasi OR-Tools dilakukan.
