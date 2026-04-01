# 🌙 Dokumentasi — Peta Silaturahmi Lebaran Efisien

> **Dibuat oleh:** ALIF TOWEW  
> **Algoritma:** Travelling Salesman Problem (TSP)  
> **File utama:** `app.py`

---

## 📖 Deskripsi Singkat

Aplikasi web interaktif yang membantu pengguna menemukan **rute kunjungan silaturahmi Lebaran paling efisien**. Pengguna cukup klik titik-titik lokasi di peta, lalu aplikasi secara otomatis menghitung urutan kunjungan terpendek menggunakan algoritma TSP.

---

## 📦 Dependensi

| Library | Versi | Fungsi |
|---|---|---|
| `gradio` | — | Membangun antarmuka UI web |
| `folium` | — | Render peta interaktif (output) |
| `networkx` | — | Algoritma graf & TSP approximation |
| `scipy` | — | Kalkulasi matriks jarak antar koordinat |
| `requests` | — | Ambil rute jalan nyata dari API OSRM |

Install semua dependensi:
```bash
pip install -r requirements.txt
```

---

## ⚙️ Alur Kerja

```
┌──────────────────────────────────────────────────────────────┐
│  1. Render peta Leaflet (HTML+JS) dalam iframe Gradio        │
│  2. User mencari lokasi via geocoder & klik titik di peta    │
│  3. Koordinat disimpan ke window.userCoords (JavaScript)     │
│  4. User tekan tombol "Hitung Rute Tercepat"                 │
│  5. JS Bridge ambil koordinat dari iframe → kirim ke Python  │
│  6. Python hitung rute optimal (TSP via NetworkX)            │
│  7. Tarik rute jalan nyata via API OSRM (fallback: garis)    │
│  8. Render peta output (Folium) + teks urutan kunjungan      │
└──────────────────────────────────────────────────────────────┘
```

---

## 🔍 Penjelasan Per Bagian Kode

### 1. Peta Input — `map_html` (Baris 10–78)

Peta **Leaflet.js** di-embed sebagai `iframe` di dalam UI Gradio menggunakan teknik `srcdoc` + `html.escape` (tanpa file statis tambahan).

**Fitur:**
- **Geocoder** — kotak pencarian lokasi (nama jalan/kota)
- **Klik peta** → menambahkan marker & menyimpan `[lat, lng]` ke `window.userCoords`
- Titik **pertama** otomatis jadi **🚀 START** (marker hijau), titik berikutnya marker biru
- Fungsi `resetMap()` untuk menghapus semua marker

---

### 2. JavaScript Bridge (Baris 84–102)

Karena Leaflet berjalan di dalam iframe (konteks terpisah dari Gradio), dibutuhkan **JS bridge** untuk transfer data:

| Fungsi JS | Tujuan |
|---|---|
| `js_get_coords` | Membaca `window.userCoords` dari iframe → JSON string ke Python |
| `js_reset_map` | Memanggil `resetMap()` di dalam iframe untuk bersihkan marker |

---

### 3. Logika Hitung Rute — `solve_efficient_route()` (Baris 105–186)

Fungsi utama yang menerima koordinat JSON dari JavaScript dan mengembalikan peta + teks rute.

#### Alur Kalkulasi:

```python
coords = json.loads(coords_json)          # Parse JSON koordinat

# Jika ≥ 3 titik → jalankan TSP
dist_matrix = squareform(pdist(coords))   # Hitung matrix jarak Euclidean
G = nx.from_numpy_array(dist_matrix)      # Buat graf berbobot
cycle_route = nx.approximation.traveling_salesman_problem(G, cycle=True)

# Rotasi array agar selalu mulai dari titik 0 (START / titik pertama diklik)
idx_zero = cycle_route.index(0)
route_indices = cycle_route[idx_zero:] + cycle_route[:idx_zero]
```

| Jumlah Titik | Perilaku |
|---|---|
| < 2 | Tampilkan pesan error |
| = 2 | Langsung A → B, tanpa TSP |
| ≥ 3 | Kalkulasi TSP untuk urutan optimal |

#### Render Rute di Peta Output:

- **Coba OSRM API** (`router.project-osrm.org`) → gambar rute mengikuti jalan nyata
- **Fallback** jika OSRM gagal/timeout → garis putus-putus lurus antar titik

---

### 4. Antarmuka UI Gradio (Baris 189–220)

Layout **2 kolom** dengan tema `emerald`:

| Kolom Kiri | Kolom Kanan |
|---|---|
| Peta input (Leaflet iframe) | Peta output rute optimal (Folium HTML) |
| Tombol Reset & Hitung Rute | Teks urutan kunjungan |

**Event handler tombol:**
- **🗑️ Reset Map** → panggil `js_reset_map`, bersihkan semua marker di peta input
- **🚀 Hitung Rute Tercepat** → jalankan `js_get_coords` → kirim ke `solve_efficient_route` → tampilkan hasil

---

## ▶️ Cara Menjalankan

```bash
python app.py
```

Buka browser di `http://localhost:7860`

---

## 🧠 Catatan Teknis

- **Teknik embed iframe**: Peta Leaflet di-embed via `srcdoc` + `html.escape` agar tidak memerlukan file HTML terpisah.
- **Rotasi array TSP**: Memastikan rute selalu dimulai dari titik yang diklik pertama (rumah pengguna), bukan titik acak hasil algoritma.
- **Dual map render**: Peta *input* (Leaflet, untuk memilih titik) dan peta *output* (Folium, untuk menampilkan rute) adalah dua komponen terpisah.
- **TSP Approximation**: NetworkX menggunakan algoritma aproksimasi (bukan brute-force), sehingga cocok untuk titik dalam jumlah besar tanpa waktu komputasi lama.
