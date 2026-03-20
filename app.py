import gradio as gr
import folium
import networkx as nx
from scipy.spatial.distance import pdist, squareform
import json
import html

# --- 1. HTML Peta Leaflet + Geocoder (Search) ---
map_html = """
<!DOCTYPE html>
<html>
<head>
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
    <link rel="stylesheet" href="https://unpkg.com/leaflet-control-geocoder/dist/Control.Geocoder.css" />
    <script src="https://unpkg.com/leaflet-control-geocoder/dist/Control.Geocoder.js"></script>
    <style>body, html { margin: 0; padding: 0; height: 100%; }</style>
</head>
<body>
    <div id="map" style="width: 100vw; height: 100vh;"></div>
    <script>
        // Titik awal peta
        var map = L.map('map').setView([-6.8400, 107.4780], 13);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap'
        }).addTo(map);

        L.Control.geocoder({
            defaultMarkGeocode: false,
            placeholder: "Cari lokasi rumah..."
        }).on('markgeocode', function(e) {
            map.setView(e.geocode.center, 16);
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
            
            // Mengirim koordinat ke Gradio parent window
            window.parent.postMessage({type: 'map_click', coords: JSON.stringify(coords)}, '*');
        });

        // Reset peta saat ditekan dari UI Gradio
        window.addEventListener('message', function(e) {
            if(e.data === 'reset_map') {
                markers.forEach(m => map.removeLayer(m));
                markers = [];
                coords = [];
                window.parent.postMessage({type: 'map_click', coords: '[]'}, '*');
            }
        });
    </script>
</body>
</html>
"""

safe_html = html.escape(map_html)
iframe_html = f'<iframe id="leaflet_iframe" srcdoc="{safe_html}" width="100%" height="450px" style="border: 1px solid #ddd; border-radius: 8px;"></iframe>'

# --- 2. Komunikasi Javascript (DIPERBAIKI) ---
listener_js = """
function() {
    window.addEventListener('message', function(event) {
        if (event.data && event.data.type === 'map_click') {
            // Memastikan data masuk ke Textarea Gradio dengan Native Setter
            var elem = document.querySelector('#raw_coords textarea');
            if (elem) {
                // Trik ini wajib dipakai di Gradio/Svelte agar state-nya sadar ada perubahan
                var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
                nativeInputValueSetter.call(elem, event.data.coords);
                
                // Memicu event input manual
                elem.dispatchEvent(new Event('input', { bubbles: true }));
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
    return "";
}
"""

# --- 3. Kalkulasi TSP ---
def solve_efficient_route(coords_json):
    try:
        if not coords_json or coords_json.strip() == "" or coords_json == "[]":
            return None, "⚠️ Peta masih kosong. Silakan cari lokasi dan klik minimal 2 titik pada peta."
        
        coords = json.loads(coords_json)
        n = len(coords)
        
        if n < 2:
            return None, "⚠️ Dibutuhkan minimal 2 titik untuk membuat rute."
            
        names = [f"Lokasi {i+1}" for i in range(n)]
        names[0] += " (START)"
        
        if n == 2:
            route_indices = [0, 1]
        else:
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
            elif step == len(route_indices)-1: order_txt = "🏁 FINISH"
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
        
        return m._repr_html_(), f"✅ Rute Optimal Ditemukan:\n{' ➡️ '.join(route_names)}"
        
    except Exception as e:
        return None, f"❌ Terjadi kesalahan proses: {str(e)}"

# --- 4. UI Gradio ---
with gr.Blocks(js=listener_js, theme=gr.themes.Default(primary_hue="emerald")) as app:
    gr.Markdown("# 🌙 Peta Silaturahmi Lebaran Efisien")
    
    with gr.Row():
        with gr.Column(scale=1):
            gr.Markdown("### 1️⃣ Cari & Pilih Lokasi di Peta\nGunakan ikon kaca pembesar (🔍) untuk mencari alamat, lalu **klik** lokasi tersebut untuk menandainya.")
            gr.HTML(iframe_html)
            
            # Wajib ditambahkan lines=2 agar dirender sebagai <textarea> sesuai dengan selektor JS kita
            latlng_input = gr.Textbox(lines=2, label="Raw Data JSON (Terisi Otomatis)", interactive=False, elem_id="raw_coords")
            
            with gr.Row():
                clear_btn = gr.Button("🗑️ Reset Map", variant="secondary")
                submit_btn = gr.Button("🚀 Hitung Rute Tercepat", variant="primary")
                
        with gr.Column(scale=1):
            gr.Markdown("### 2️⃣ Hasil Rute Optimal")
            output_map = gr.HTML(label="Peta Rute")
            output_text = gr.Textbox(label="Urutan Kunjungan", lines=4)

    # Event Binding
    clear_btn.click(fn=None, inputs=None, outputs=latlng_input, js=reset_js)
    submit_btn.click(fn=solve_efficient_route, inputs=latlng_input, outputs=[output_map, output_text])

if __name__ == "__main__":
    app.launch()