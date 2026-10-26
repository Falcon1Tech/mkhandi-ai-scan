import SwiftUI
import PhotosUI
private enum T {
 static let bg=Color(red:0.025,green:0.04,blue:0.075), card=Color(red:0.055,green:0.085,blue:0.14), panel=Color(red:0.035,green:0.06,blue:0.105)
 static let red=Color(red:1,green:0.07,blue:0.25), cyan=Color(red:0.28,green:0.82,blue:1), green=Color(red:0.1,green:0.9,blue:0.65), amber=Color(red:1,green:0.72,blue:0.25), purple=Color(red:0.72,green:0.4,blue:1)
}
struct ScanResult: Decodable {
 let instrument:String?; let recommendation:String?; let overall_bias:String?; let confidence:Double?; let summary:String?; let market_structure:String?; let timeframe_analysis:String?; let entry:Double?; let stop_loss:Double?; let take_profit_1:Double?; let take_profit_2:Double?; let risk_reward:Double?; let invalidation:String?; let reasons:[String]?; let warnings:[String]?
}
struct ContentView: View {
 @State private var tab="AI Deep Scan"
 @State private var instrument="Boom 1000 Index"
 @State private var timeframe="M15"
 @State private var items:[String:PhotosPickerItem]=[:]
 @State private var images:[String:Data]=[:]
 @State private var scanning=false
 @State private var status="Choose chart screenshots to begin analysis."
 @State private var result:ScanResult?
 @State private var error:String?
 private let frames=["H1","M30","M15"]
 var body: some View {
  ZStack { T.bg.ignoresSafeArea(); VStack(spacing:0) { header; ScrollView { VStack(alignment:.leading,spacing:15) { if tab=="AI Deep Scan" { deepScan } else if tab=="Watchlist" { watchlist } else if tab=="Signals" { signals } else { dashboard } }.padding(15) }; tabs } }
  .preferredColorScheme(.dark)
  .onChange(of:items) { _, new in Task { for (frame,item) in new { if let data=try? await item.loadTransferable(type:Data.self) { await MainActor.run { images[frame]=data } } } } }
  .alert("Scan error",isPresented:Binding(get:{error != nil},set:{if !$0 {error=nil}})) { Button("OK",role:.cancel){error=nil} } message:{Text(error ?? "")}
 }
 private var header:some View { HStack(spacing:11) { ZStack { Circle().stroke(T.red,lineWidth:3).frame(width:43,height:43); HStack(spacing:3){Capsule().fill(.white).frame(width:5,height:17);Capsule().fill(T.red).frame(width:5,height:27);Capsule().fill(.white).frame(width:5,height:21)} }; VStack(alignment:.leading,spacing:3){Text("MKHANDI AI SCAN").font(.system(size:18,weight:.black,design:.rounded));Text("NATIVE iOS • CHART ANALYSIS").font(.system(size:9,weight:.heavy)).tracking(1).foregroundStyle(T.red)};Spacer();Circle().fill(T.green).frame(width:8,height:8);Text("READY").font(.system(size:10,weight:.black)).foregroundStyle(T.green) }.padding(14).background(T.card).clipShape(RoundedRectangle(cornerRadius:18)).overlay(RoundedRectangle(cornerRadius:18).stroke(.white.opacity(0.12))).padding(.horizontal,12).padding(.top,7) }
 private var deepScan:some View { VStack(alignment:.leading,spacing:14) {
  eyebrow("MKHANDI AI QUALIFICATION");Text("AI Deep Scan").font(.system(size:27,weight:.black))
  Text("Upload chart screenshots. The AI analyses selected timeframes and returns a validated signal or NO TRADE.").font(.system(size:13)).foregroundStyle(.white.opacity(0.68))
  label("WATCHLIST ASSET")
  Menu { ForEach(["Boom 1000 Index","Boom 500 Index","Volatility 75 Index","Volatility 25 (1s) Index","Crash 5000 Index","Crash 1000 Index","Gold / XAUUSD"],id:\.self){v in Button(v){instrument=v}} } label:{HStack{Text(instrument).fontWeight(.bold);Spacer();Image(systemName:"chevron.down")}.padding(13).background(T.panel).clipShape(RoundedRectangle(cornerRadius:11))}
  label("EXECUTION TIMEFRAME")
  HStack { ForEach(["M5","M15","M30","H1"],id:\.self){tf in Button(tf){timeframe=tf}.font(.system(size:13,weight:.bold)).foregroundStyle(.white).frame(maxWidth:.infinity).padding(11).background(timeframe==tf ? T.red:T.panel).clipShape(RoundedRectangle(cornerRadius:9))} }
  label("CHART SCREENSHOTS • H1, M30, M15")
  ForEach(frames,id:\.self){frame in PhotosPicker(selection:Binding(get:{items[frame]},set:{items[frame]=$0}),matching:.images){HStack(spacing:12){Image(systemName:images[frame] == nil ? "photo.badge.plus":"checkmark.circle.fill").font(.system(size:22)).foregroundStyle(images[frame] == nil ? T.cyan:T.green);VStack(alignment:.leading,spacing:4){Text("\(frame) CHART").font(.system(size:13,weight:.heavy));Text(images[frame] == nil ? "Tap to select screenshot":"Screenshot loaded").font(.system(size:11)).foregroundStyle(.white.opacity(0.6))};Spacer();Image(systemName:"chevron.right").foregroundStyle(.white.opacity(0.4))}.padding(13).background(T.panel).clipShape(RoundedRectangle(cornerRadius:11)).overlay(RoundedRectangle(cornerRadius:11).stroke(images[frame] == nil ? .white.opacity(0.12):T.green.opacity(0.7)))}.buttonStyle(.plain)}
  Button { Task { await scan() } } label:{HStack{if scanning{ProgressView().tint(.white)}else{Image(systemName:"brain.head.profile")};Text(scanning ? "ANALYSING CHARTS…":"RUN AI DEEP SCAN")}.font(.system(size:14,weight:.black)).frame(maxWidth:.infinity).padding(15).background(LinearGradient(colors:[T.red,Color(red:0.75,green:0.01,blue:0.17)],startPoint:.leading,endPoint:.trailing)).clipShape(RoundedRectangle(cornerRadius:12))}.disabled(scanning || frames.contains(where:{images[$0]==nil})
  )
  Text(status).font(.system(size:12,weight:.medium)).foregroundStyle(T.cyan)
  if let result { resultView(result) }
 }.padding(15).background(T.card).clipShape(RoundedRectangle(cornerRadius:19)).overlay(RoundedRectangle(cornerRadius:19).stroke(.white.opacity(0.12))) }
 private func resultView(_ r:ScanResult)->some View { VStack(alignment:.leading,spacing:12){HStack{VStack(alignment:.leading){eyebrow("AI ANALYSIS RESULT");Text(r.instrument ?? instrument).font(.system(size:20,weight:.black))};Spacer();Text("\(Int(r.confidence ?? 0))%").font(.system(size:23,weight:.black))};let rec=(r.recommendation ?? "NO TRADE").uppercased();Text(rec).font(.system(size:25,weight:.black)).foregroundStyle(rec=="BUY" ? T.green:(rec=="SELL" ? T.red:T.amber));Text(r.summary ?? "No summary returned.").font(.system(size:13));LazyVGrid(columns:[GridItem(.flexible()),GridItem(.flexible())],spacing:8){price("ENTRY",r.entry);price("STOP LOSS",r.stop_loss);price("TAKE PROFIT 1",r.take_profit_1);price("TAKE PROFIT 2",r.take_profit_2);price("RISK / REWARD",r.risk_reward);tile("TIMEFRAME",r.executionTimeframe ?? timeframe)};detail("MULTI-TIMEFRAME READ",r.timeframe_analysis ?? "Not provided.",T.cyan);detail("MARKET STRUCTURE",r.market_structure ?? "Not provided.",T.purple);detail("WHY THIS SETUP",(r.reasons ?? []).enumerated().map{"Reason \($0.offset+1): \($0.element)"}.joined(separator:"\n\n"),T.cyan);detail("INVALIDATION",r.invalidation ?? "Not provided.",T.cyan);detail("WARNINGS",(r.warnings ?? []).map{"⚠︎ "+$0}.joined(separator:"\n\n"),T.amber)}.padding(13).background(T.panel).clipShape(RoundedRectangle(cornerRadius:14)) }
 private func price(_ title:String,_ value:Double?)->some View {tile(title,value.map{String(format:"%.5f",$0)} ?? "—")}
 private func tile(_ title:String,_ value:String)->some View {VStack(alignment:.leading,spacing:5){Text(title).font(.system(size:9,weight:.heavy)).foregroundStyle(.white.opacity(0.55));Text(value).font(.system(size:13,weight:.bold))}.frame(maxWidth:.infinity,alignment:.leading).padding(10).background(T.card).clipShape(RoundedRectangle(cornerRadius:9))}
 private func detail(_ title:String,_ text:String,_ color:Color)->some View {VStack(alignment:.leading,spacing:7){Text(title).font(.system(size:11,weight:.black)).tracking(0.8).foregroundStyle(color);Text(text.isEmpty ? "No additional details.":text).font(.system(size:13,weight:.medium)).lineSpacing(4).frame(maxWidth:.infinity,alignment:.leading).padding(11).background(T.card).clipShape(RoundedRectangle(cornerRadius:9)).overlay(alignment:.leading){RoundedRectangle(cornerRadius:2).fill(color).frame(width:3)}}}
 private var dashboard:some View {VStack(alignment:.leading,spacing:13){eyebrow("WELCOME TO MKHANDI");Text("Your market analysis workspace").font(.system(size:25,weight:.black));Text("Native iPhone interface for chart qualification and signal review. This app does not place trades.").font(.system(size:13)).foregroundStyle(.white.opacity(0.7));feature("AI Deep Scan","Upload H1, M30 and M15 screenshots for AI analysis.","brain.head.profile",T.cyan){tab="AI Deep Scan"};feature("Watchlist","View supported instruments.","chart.xyaxis.line",T.green){tab="Watchlist"};feature("Signals","Review your latest analysis.","bolt.fill",T.amber){tab="Signals"}}.padding(17).background(T.card).clipShape(RoundedRectangle(cornerRadius:18))}
 private var watchlist:some View {VStack(alignment:.leading,spacing:12){eyebrow("MARKET WATCHLIST");Text("Supported assets").font(.system(size:25,weight:.black));Text("Live Deriv streaming is not yet implemented in this native iOS build; these are the supported instruments, not live quotes.").font(.system(size:12)).foregroundStyle(.white.opacity(0.65));ForEach(["Boom 1000 Index","Boom 500 Index","Volatility 75 Index","Volatility 25 (1s) Index","Crash 5000 Index","Crash 1000 Index","Gold / XAUUSD"],id:\.self){asset in HStack{Image(systemName:"chart.xyaxis.line").foregroundStyle(T.cyan);Text(asset).font(.system(size:13,weight:.bold));Spacer();Text("SUPPORTED").font(.system(size:9,weight:.black)).foregroundStyle(T.green)}.padding(12).background(T.panel).clipShape(RoundedRectangle(cornerRadius:10))}}.padding(15).background(T.card).clipShape(RoundedRectangle(cornerRadius:18))}
 private var signals:some View {VStack(alignment:.leading,spacing:12){eyebrow("SIGNAL REVIEW");Text("Latest analysis").font(.system(size:25,weight:.black));if let result{resultView(result)}else{Text("No analysis in this session yet. Open AI Deep Scan and upload the required charts.").font(.system(size:13)).foregroundStyle(.white.opacity(0.65))}}.padding(15).background(T.card).clipShape(RoundedRectangle(cornerRadius:18))}
 private var tabs:some View {HStack{tabButton("Dashboard","square.grid.2x2");tabButton("Watchlist","chart.xyaxis.line");tabButton("AI Deep Scan","brain.head.profile");tabButton("Signals","bolt.fill")}.padding(.top,8).background(T.bg)}
 private func tabButton(_ name:String,_ icon:String)->some View {Button{tab=name}{VStack(spacing:5){Image(systemName:icon).font(.system(size:16,weight:.bold));Text(name=="AI Deep Scan" ? "Deep Scan":name).font(.system(size:9,weight:.heavy))}.foregroundStyle(tab==name ? T.red:.white.opacity(0.55)).frame(maxWidth:.infinity).padding(.bottom,7)}}
 private func feature(_ title:String,_ subtitle:String,_ icon:String,_ color:Color,_ action:@escaping()->Void)->some View {Button(action:action){HStack{Image(systemName:icon).font(.system(size:22)).foregroundStyle(color).frame(width:40,height:40).background(color.opacity(0.12)).clipShape(RoundedRectangle(cornerRadius:9));VStack(alignment:.leading,spacing:4){Text(title).font(.system(size:14,weight:.black)).foregroundStyle(.white);Text(subtitle).font(.system(size:11)).foregroundStyle(.white.opacity(0.65)).multilineTextAlignment(.leading)};Spacer();Image(systemName:"chevron.right").foregroundStyle(.white.opacity(0.4))}.padding(12).background(T.panel).clipShape(RoundedRectangle(cornerRadius:11))}.buttonStyle(.plain)}
 private func eyebrow(_ s:String)->some View {Text(s).font(.system(size:10,weight:.black)).tracking(1.4).foregroundStyle(T.red)}
 private func label(_ s:String)->some View {Text(s).font(.system(size:10,weight:.black)).tracking(0.7).foregroundStyle(T.cyan)}
 @MainActor private func scan() async {
  guard frames.allSatisfy({images[$0] != nil}) else {error="Please select H1, M30 and M15 chart screenshots.";return}
  scanning=true;status="Uploading charts to MKHANDI AI…";defer{scanning=false}
  do {
   var request=URLRequest(url:URL(string:"https://mkhandi-ai-scan.vercel.app/api/scan")!);request.httpMethod="POST";let boundary="MKHANDI-\(UUID().uuidString)";request.setValue("multipart/form-data; boundary=\(boundary)",forHTTPHeaderField:"Content-Type");request.timeoutInterval=90
   var body=Data();func append(_ s:String){body.append(Data(s.utf8))}
   func field(_ name:String,_ value:String){append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n")}
   field("instrument",instrument);field("executionTimeframe",timeframe)
   for frame in frames {guard let data=images[frame] else{continue};append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(frame)\"; filename=\"\(frame.lowercased()).jpg\"\r\nContent-Type: image/jpeg\r\n\r\n");body.append(data);append("\r\n")}
   append("--\(boundary)--\r\n");request.httpBody=body
   let (data,response)=try await URLSession.shared.data(for:request);guard let http=response as? HTTPURLResponse else{throw ScanError.message("Invalid server response.")};guard (200..<300).contains(http.statusCode) else{throw ScanError.message(String(data:data,encoding:.utf8) ?? "Server error")}
   result=try JSONDecoder().decode(ScanResult.self,from:data);status="Analysis complete. Review the reasoning and validation warnings before making any decision."
  } catch {errorMessageSet(error.localizedDescription);status="Scan failed. Check connection and retry."}
 }
 private func errorMessageSet(_ message:String){error=message}
}
enum ScanError:LocalizedError {case message(String);var errorDescription:String?{if case let .message(s)=self{return s};return "Unexpected scan error."}}
