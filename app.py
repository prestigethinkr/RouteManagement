import gradio as gr
import folium
import networkx as nx
from scipy.spatial.distance import pdist, squareform
import json
import html

# --- 1. HTML Peta Leaflet (Dibungkus Iframe utuh) ---
map_html = """
<!DOCTYPE html>
<html>
<head>
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
    <style>body, html { margin: 0; padding: 0; height: 100%; }</style>
</head>
<body>
    <div id="map" style="width: 100vw; height: 100vh;"></div>
    <script>
        // View awal langsung diset ke koordinat Padalarang
        var map = L.map('map').setView([-6.8400, 107.4780], 13);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap'
        }).addTo(map);
        
        var coords = [];
        var markers = [];
        
        map.on('click', function(e) {
            var lat = e.latlng.lat;
            var lng = e.latlng.lng;
            var marker = L.marker([lat, lng]).addTo(map)
                .bindPopup("Destinasi " + (coords.length + 1)).openPopup();
            markers.push(marker);
            coords.push([lat, lng]);
            
            // Kirim data koordinat ke aplikasi Gradio (parent window)
            window.parent.postMessage({type: 'map_click', coords: JSON.stringify(coords)}, '*');
        });

        // Listener untuk membersihkan peta jika tombol reset di Gradio ditekan
        window.addEventListener('message', function(e) {
            if(e.data === 'reset_map') {
                markers.forEach(m => map.removeLayer(m));
                markers = [];
                coords = [];
            }
        });
    </script>
</body>
</html>
"""

# Escape HTML agar tidak merusak formatting string iframe bawaan Gradio
safe_html = html.escape(map_html)
iframe_html = f'<iframe id="leaflet_iframe" srcdoc="{safe_html}" width="100%" height="450px" style="border: 1px solid #ddd; border-radius: 8px;"></iframe>'

# --- 2. JS Listener & Bridge Komunikasi UI ---
listener_js = """
function() {
    window.addEventListener('message', function(event) {
        if (event.data && event.data.type === 'map_click') {
            // Targetkan elemen input text Gradio lewat ID
            var container = document.getElementById('raw_coords');
            if (container) {
                var textarea = container.querySelector('textarea');
                if (textarea) {
                    textarea.value = event.data.coords;
                    // Trigger 'input' agar sistem Gradio sadar ada perubahan teks
                    textarea.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }
        }
    });
}
"""

reset_js = """
function() {
    var iframe = document.getElementById('leaflet_iframe');
    if (iframe && iframe.contentWindow) {
        iframe.contentWindow.postMessage('reset_map', '*');
    }
    return ""; // Mengosongkan textbox Gradio
}
"""

# --- 3. Fungsi Logika Python (TSP Solver) ---
def solve_efficient_route(coords_json):
    try:
        if not coords_json or coords_json.strip() == "" or coords_json == "[]":
            return None, "⚠️ Silakan klik minimal 2 lokasi pada peta di atas terlebih dahulu."
        
        coords = json.loads(coords_json)
        n = len(coords)
        
        if n < 2:
            return None, "⚠️ Pilih minimal 2 titik lokasi."
            
        names = [f"Lokasi {i+1}" for i in range(n)]
        names[0] += " (START)"
        
        # Kalkulasi matriks jarak dan pembuatan rute aproksimasi
        dist_matrix = squareform(pdist(coords))
        G = nx.from_numpy_array(dist_matrix)
        route_indices = nx.approximation.traveling_salesman_problem(G, cycle=False)
        
        m = folium.Map(location=coords[route_indices[0]], zoom_start=14)
        path_coords = []
        route_names = []
        
        for step, idx in enumerate(route_indices):
            lat_lon = coords[idx]
            path_coords.append(lat_lon)
            
            if step == 0: order_txt = "🚀 START"
            elif step == len(route_indices)-1: order_txt = f"🏁 FINISH"
            else: order_txt = f"📍 Urutan Ke-{step+1}"
            
            route_names.append(f"{step+1}. Lokasi {idx+1}")
            color = "green" if step == 0 else "red" if step == len(route_indices)-1 else "blue"
            
            folium.Marker(
                location=lat_lon,
                popup=f"<b>{order_txt}</b>",
                icon=folium.Icon(color=color, icon="info-sign"),
                tooltip=f"Tujuan {step+1}"
            ).add_to(m)
            
        folium.PolyLine(path_coords, color="#2ecc71", weight=5, opacity=0.8, dash_array="10").add_to(m)
        
        return m._repr_html_(), f"✅ Rute Optimal:\n{' ➡️ '.join(route_names)}"
        
    except Exception as e:
        return None, f"❌ Terjadi kesalahan: {str(e)}"

# --- 4. Antarmuka Gradio ---
with gr.Blocks(js=listener_js, theme=gr.themes.Default(primary_hue="emerald")) as app:
    gr.Markdown("# 🌙 Peta Silaturahmi Lebaran Efisien")
    
    with gr.Row():
        with gr.Column(scale=1):
            gr.Markdown("### 1️⃣ Pilih Lokasi di Peta")
            gr.HTML(iframe_html)
            
            # Textbox diset menjadi readonly, tetapi sengaja di-expose agar user sadar ada data JSON yang masuk
            latlng_input = gr.Textbox(label="Data Kumpulan Koordinat", interactive=False, elem_id="raw_coords")
            
            with gr.Row():
                clear_btn = gr.Button("🗑️ Reset Map", variant="secondary")
                submit_btn = gr.Button("🚀 Hitung Rute Tercepat", variant="primary")
                
        with gr.Column(scale=1):
            gr.Markdown("### 2️⃣ Hasil Rute Optimal")
            output_map = gr.HTML(label="Peta Rute")
            output_text = gr.Textbox(label="Urutan Kunjungan", lines=4)

    # Event Actions
    clear_btn.click(fn=None, inputs=None, outputs=latlng_input, js=reset_js)
    submit_btn.click(fn=solve_efficient_route, inputs=latlng_input, outputs=[output_map, output_text])

if __name__ == "__main__":
    app.launch()